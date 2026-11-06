// celld-agent-to-rag：智能体会话导入知识库（独立活跃容器里的唯一实例，同时是本舰队的根）
//
// 对外契约与旧 kb-sync 完全一致（插件只认这些端点），唯一变化是内部执行模型：
//   旧：/ingest 与 /run 把 uuid 投进队列，队列消费者同步跑完整流程（含最长 600 秒轮询）。
//   新：/ingest 与 /run 用 createBatch 创建 Workflow 实例；实例号 = uuid-版本，
//       同版本重复触发由平台静默去重，因此不再需要 KV 锁。
//
// 本实例自带 cron（它是自己舰队的根）。celld 的限制是「cron 只有根会触发」，
// 旧架构为此专门做了中央 scheduler；拆成独立容器后这一跳没有存在必要了。
import type { Env } from "./env";
import {
  collectWork,
  instanceId,
  listPendingApproval,
  type WorkItem,
} from "./workflows/collect";
import {clearApproved,
  delLedger,
  delMd,
  delMeta,
  delRaw,
  getLedger,
  isApproved,
  listMd,
  listMetas,
  loadMd,
  putLedger,
  putMeta,
  saveRaw,
  setApproved,
  type SessionMeta,
  loadRaw,
} from "./lib/store";
import { deleteDocument } from "./lib/ragferrite";
import { entriesFromSession, pushEntries, forgetTimeline } from "./lib/timeline";
import type { RawSession } from "./lib/md";
import { SessionSyncFlow } from "./workflows/session-sync";

// celld 要求 Workflow 类必须由 worker 模块导出，否则节点启动即失败：
// 「workflow class SessionSyncFlow is not exported by the Worker module」
export { SessionSyncFlow };

function authorized(request: Request, env: Env): boolean {
  const token =
    request.headers.get("x-ingest-token") || new URL(request.url).searchParams.get("token") || "";
  return !!env.INGEST_TOKEN && token === env.INGEST_TOKEN;
}

/** 每轮最多创建几个实例。用户定的保守值是 2（≈旧 max_concurrency=2 的吞吐）。 */
function concurrency(env: Env): number {
  const n = Number.parseInt(env.SYNC_CONCURRENCY ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 2;
}

/** 用 createBatch 建实例：平台对「已存在的实例号」是静默跳过，所以这里天然是去重语义。 */
async function startSessions(env: Env, items: WorkItem[]) {
  const batch = items.slice(0, concurrency(env)).map((it) => {
    const wf = instanceId(it.uuid, it.updated_at);
    return { id: wf, params: { uuid: it.uuid, wf } };
  });
  if (!batch.length) return { started: [] as string[], restarted: [] as string[], deduped: 0 };
  const created = await env.SYNC_FLOW.createBatch(batch);
  const createdIds = new Set(created.map((i) => i.id));
  const skipped = batch.filter((b) => !createdIds.has(b.id));

  // 被平台跳过的实例号说明它已存在：运行中的保持不动（这正是我们要的去重），
  // 已到终态的必须 restart()，否则「台账落后但实例号已用掉」的会话会永久卡死——
  // 旧形态靠队列重投自愈，新形态必须显式给出这条重跑通道。
  const restarted: string[] = [];
  for (const it of skipped) {
    try {
      const inst = await env.SYNC_FLOW.get(it.id);
      const st = (await inst.status()) as { status?: string };
      if (st.status === "complete" || st.status === "errored" || st.status === "terminated") {
        await inst.restart();
        restarted.push(it.id);
      }
    } catch {
      /* 查不到就跳过，下一轮对账还会再来 */
    }
  }
  return {
    started: created.map((i) => i.id),
    restarted,
    deduped: skipped.length - restarted.length,
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "celld-agent-to-rag",
        model: "Workflow 实例（等待期休眠，不占 isolate）",
        storage: "KV台账+R2文件",
        concurrency: concurrency(env),
      });
    }
    if (!authorized(request, env)) {
      return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });
    }

    // 摄取：插件推送变更会话（含附件 base64）
    if (url.pathname === "/ingest" && request.method === "POST") {
      const raw = (await request.json()) as RawSession;
      if (!raw.uuid || !raw.messages?.length) {
        return Response.json({ ok: false, error: "bad payload" }, { status: 400 });
      }
      await saveRaw(env.FILES, raw.uuid, raw);
      await putMeta(env.STATE, {
        uuid: raw.uuid,
        conversation_id: raw.conversation_id,
        title: raw.title || "",
        platform: raw.platform || "",
        updated_at: raw.updated_at,
        pushed_at: new Date().toISOString(),
      });
      const ledger = await getLedger(env.STATE, raw.uuid);
      // 审批闸门：未审批过的新会话只存不处理；已审批/已有台账的变更自动重推
      if (!ledger && !(await isApproved(env.STATE, raw.uuid))) {
        return Response.json({ ok: true, pending_approval: true });
      }
      const dup =
        ledger !== null &&
        ledger.updated_at === raw.updated_at &&
        ledger.parse_status === "completed";
      if (dup) return Response.json({ ok: true, queued: false, skipped: true });
      const r = await startSessions(env, [{ uuid: raw.uuid, updated_at: raw.updated_at }]);
      return Response.json({ ok: true, queued: r.started.length > 0, restarted: r.restarted.length > 0, deduped: r.deduped > 0 });
    }

    // 镜像清单：插件据此对齐文件夹
    if (url.pathname === "/files" && request.method === "GET") {
      return Response.json({ ok: true, files: await listMd(env.FILES) });
    }

    // 入库回执（2026-11-06 新增）：插件的「受理 200」只代表已排队，不代表入库完成。
    // 体检实证：插件按受理记账后，会话从语料里静默消失（台账 completed、语料缺失）。
    // 对账口径改为：只有 parse_status=completed 的台账才算入库完成。
    if (url.pathname === "/receipts" && request.method === "GET") {
      const receipts: Array<Record<string, unknown>> = [];
      for (const m of await listMetas(env.STATE)) {
        const l = await getLedger(env.STATE, m.uuid);
        receipts.push({
          uuid: m.uuid,
          md: l?.md ?? null,
          parse_status: l?.parse_status ?? "none",
          updated_at: l?.updated_at ?? m.updated_at,
          synced_at: l?.synced_at ?? null,
        });
      }
      return Response.json({ ok: true, receipts });
    }
    const fileMatch = url.pathname.match(/^\/files\/(.+)$/);
    if (fileMatch && request.method === "GET") {
      const name = decodeURIComponent(fileMatch[1] ?? "");
      const text = await loadMd(env.FILES, name);
      return text == null ? new Response("not found", { status: 404 }) : new Response(text);
    }

    // 下架：文件夹文件被用户删除时由插件调用
    if (fileMatch && request.method === "DELETE") {
      const name = decodeURIComponent(fileMatch[1] ?? "");
      let hit: string | null = null;
      for (const m of await listMetas(env.STATE)) {
        const l = await getLedger(env.STATE, m.uuid);
        if (l && l.md === name) {
          hit = m.uuid;
          break;
        }
      }
      if (!hit) return Response.json({ ok: false, error: "no ledger for file" }, { status: 404 });
      try {
        await deleteDocument(env, name);
      } catch {
        /* 上游删除失败不阻断本地台账清理 */
      }
      await delMd(env.FILES, name);
      await delLedger(env.STATE, hit);
      await clearApproved(env.STATE, hit); // 下架即撤销审批：定时对账不得复活
      return Response.json({ ok: true, retracted: hit });
    }

    if (url.pathname === "/approve" && request.method === "POST") {
      const body = (await request.json()) as { uuid?: string };
      if (!body.uuid) return Response.json({ ok: false, error: "uuid required" }, { status: 400 });
      await setApproved(env.STATE, body.uuid);
      const meta = (await listMetas(env.STATE)).find((m) => m.uuid === body.uuid);
      const r = await startSessions(env, [
        { uuid: body.uuid, updated_at: meta?.updated_at ?? "" },
      ]);
      return Response.json({
        ok: true,
        approved: body.uuid,
        queued: r.started.length > 0,
        deduped: r.deduped > 0,
      });
    }
    if (url.pathname === "/set-approved" && request.method === "POST") {
      const body = (await request.json()) as { uuids?: string[] };
      for (const u of body.uuids || []) await setApproved(env.STATE, u);
      return Response.json({ ok: true, marked: (body.uuids || []).length });
    }
    if (url.pathname === "/purge" && request.method === "POST") {
      const body = (await request.json()) as { uuid?: string };
      if (!body.uuid) return Response.json({ ok: false }, { status: 400 });
      const l = await getLedger(env.STATE, body.uuid);
      if (l?.md) {
        try {
          await deleteDocument(env, l.md);
        } catch {
          /* 同上 */
        }
        await delMd(env.FILES, l.md);
      }
      await delLedger(env.STATE, body.uuid);
      await clearApproved(env.STATE, body.uuid);
      await delMeta(env.STATE, body.uuid);
      await delRaw(env.FILES, body.uuid);
      const tl = await forgetTimeline(env, body.uuid);
      return Response.json({ ok: true, purged: body.uuid, timeline: tl.ok });
    }
    if (url.pathname === "/pending" && request.method === "GET") {
      const pending: SessionMeta[] = await listPendingApproval(env);
      return Response.json({ ok: true, pending });
    }

    // 手动对账一轮：找出落后项并建实例（受 concurrency 限制）
    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { limit?: number };
      const result = await collectWork(env, body.limit ?? undefined);
      const r = await startSessions(env, result.items);
      return Response.json({
        ok: true,
        found: result.items.length,
        started: r.started,
        restarted: r.restarted,
        deduped: r.deduped,
      });
    }

    // 存量回填：把已入库会话的消息级时间推给时间轴。分页跑（每页 count 篇），
    // 因为 212 篇 × 平均几十条消息会远超单次 handler 预算。
    if (url.pathname === "/backfill" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { from?: number; count?: number };
      const from = Math.max(0, Math.floor(body.from ?? 0));
      const count = Math.min(Math.max(1, Math.floor(body.count ?? 10)), 30);
      const metas = (await listMetas(env.STATE)).sort((a, b) => (a.uuid < b.uuid ? -1 : 1));
      const page = metas.slice(from, from + count);
      let entries = 0, sent = 0, docs = 0;
      const failed: string[] = [];
      for (const m of page) {
        const raw = await loadRaw<RawSession>(env.FILES, m.uuid);
        if (!raw?.messages?.length) continue;
        const items = entriesFromSession(raw, m.uuid);
        if (!items.length) continue;
        docs += 1;
        entries += items.length;
        const r = await pushEntries(env, items);
        sent += r.sent;
        for (const f of r.failed) failed.push(`${m.uuid.slice(0, 8)}:${f}`);
      }
      return Response.json({
        ok: failed.length === 0,
        page: { from, count, docs_total: metas.length, has_more: from + count < metas.length },
        docs, entries, sent, failed: failed.slice(0, 5),
      });
    }

    // 查进度（Workflow 形态新增：旧队列形态只能看到最终台账）
    if (url.pathname === "/status" && request.method === "GET") {
      const uuid = url.searchParams.get("uuid") ?? "";
      if (!uuid) return Response.json({ ok: false, error: "uuid required" }, { status: 400 });
      // 实例号优先取台账；处理中时台账还没写 wf，就用 meta 的版本号推出实例号——
      // 「查进度」恰恰在处理中最有用，只依赖台账会让它在这段时间查不到东西。
      const ledger = await getLedger(env.STATE, uuid);
      let wf = ledger?.wf;
      if (!wf) {
        const meta = (await listMetas(env.STATE)).find((m) => m.uuid === uuid);
        if (meta) wf = instanceId(meta.uuid, meta.updated_at);
      }
      if (!wf) {
        return Response.json({ ok: true, uuid, instance: null, note: "无 meta 也无台账：该会话从未被处理" });
      }
      try {
        const instance = await env.SYNC_FLOW.get(wf);
        return Response.json({ ok: true, uuid, instance: wf, ledger, status: await instance.status() });
      } catch (e) {
        return Response.json(
          { ok: false, error: String(e).slice(0, 200), instance: wf },
          { status: 404 },
        );
      }
    }

    return new Response("not found", { status: 404 });
  },

  // 本实例是自己舰队的根，cron 直接生效（旧架构要靠中央 scheduler 中转）
  async scheduled(controller: unknown, env: Env): Promise<void> {
    const result = await collectWork(env);
    const r = await startSessions(env, result.items);
    console.log(
      "[agent-to-rag] scheduled",
      JSON.stringify({
        cron: (controller as { cron?: string })?.cron,
        found: result.items.length,
        started: r.started.length,
        restarted: r.restarted.length,
        deduped: r.deduped,
      }),
    );
  },
};
