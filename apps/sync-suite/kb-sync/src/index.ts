import type { Env } from "./env";
import { collectWork, listPendingApproval } from "./workflows/sync";
import { processSession, recordFailure, QUEUE_MAX_ATTEMPTS } from "./workflows/session-sync";
import { putMeta, getLedger, delLedger, loadMd, listMd, saveRaw, putLedger } from "./lib/store";
import type { RawSession } from "./lib/md";

function authorized(request: Request, env: Env): boolean {
  const token = request.headers.get("x-ingest-token") || new URL(request.url).searchParams.get("token") || "";
  return !!env.INGEST_TOKEN && token === env.INGEST_TOKEN;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "kb-sync-celld", storage: "KV台账+R2文件（零外部容器依赖）" });
    }
    if (!authorized(request, env)) return Response.json({ ok: false, error: "unauthorized" }, { status: 401 });

    // 摄取：插件推送变更会话（含附件base64）
    if (url.pathname === "/ingest" && request.method === "POST") {
      const raw = (await request.json()) as RawSession & { token?: string };
      if (!raw.uuid || !raw.messages?.length) return Response.json({ ok: false, error: "bad payload" }, { status: 400 });
      await saveRaw(env.FILES, raw.uuid, raw);
      await putMeta(env.STATE, {
        uuid: raw.uuid, conversation_id: raw.conversation_id, title: raw.title || "",
        platform: raw.platform || "", updated_at: raw.updated_at, pushed_at: new Date().toISOString(),
      });
      const ledger = await getLedger(env.STATE, raw.uuid);
      // 审批闸门：新会话(无台账)只存不处理；已有台账的会话变更自动重推
      if (!ledger) return Response.json({ ok: true, pending_approval: true });
      const dup = ledger.updated_at === raw.updated_at && ledger.parse_status === "completed";
      if (!dup) await env.QUEUE.send({ uuid: raw.uuid });
      return Response.json({ ok: true, queued: !dup, skipped: !!dup });
    }

    // 镜像清单：插件据此对齐文件夹
    if (url.pathname === "/files" && request.method === "GET") {
      const names = await listMd(env.FILES);
      return Response.json({ ok: true, files: names });
    }
    const fileMatch = url.pathname.match(/^\/files\/(.+)$/);
    if (fileMatch && request.method === "GET") {
      const name = decodeURIComponent(fileMatch[1]);
      const text = await loadMd(env.FILES, name);
      return text == null ? new Response("not found", { status: 404 }) : new Response(text);
    }
    // 下架：文件夹文件被用户删除时由插件调用
    if (fileMatch && request.method === "DELETE") {
      const name = decodeURIComponent(fileMatch[1]);
      const metas = await listPendingApproval(env); // 复用遍历：找该 md 对应 uuid
      void metas;
      const { listMetas } = await import("./lib/store");
      let hit: string | null = null;
      for (const m of await listMetas(env.STATE)) {
        const l = await getLedger(env.STATE, m.uuid);
        if (l && l.md === name) { hit = m.uuid; break; }
      }
      if (!hit) return Response.json({ ok: false, error: "no ledger for file" }, { status: 404 });
      const ledger = await getLedger(env.STATE, hit);
      if (ledger?.knowledge_id) {
        const { deleteKnowledge } = await import("./lib/weknora");
        try { await deleteKnowledge(env, ledger.knowledge_id); } catch {}
      }
      const { delMd } = await import("./lib/store");
      await delMd(env.FILES, name);
      await delLedger(env.STATE, hit);
      return Response.json({ ok: true, retracted: hit });
    }

    if (url.pathname === "/approve" && request.method === "POST") {
      const body = (await request.json()) as { uuid?: string };
      if (!body.uuid) return Response.json({ ok: false, error: "uuid required" }, { status: 400 });
      await env.QUEUE.send({ uuid: body.uuid });
      return Response.json({ ok: true, approved: body.uuid, queued: true });
    }
    if (url.pathname === "/pending" && request.method === "GET") {
      return Response.json({ ok: true, pending: await listPendingApproval(env) });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { limit?: number };
      const result = await collectWork(env, body.limit ?? undefined);
      for (let i = 0; i < result.items.length; i += 100) {
        await env.QUEUE.sendBatch(result.items.slice(i, i + 100).map((item) => ({ body: item })));
      }
      return Response.json({ ok: true, kb: result.kb, enqueued: result.items.length });
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: unknown, env: Env, ctx: unknown): Promise<void> {
    const result = await collectWork(env, 10);
    if (result.items.length) await env.QUEUE.sendBatch(result.items.map((i) => ({ body: i })));
    console.log("[kb-sync] scheduled", JSON.stringify({ enqueued: result.items.length }));
  },

  async queue(batch: MessageBatch<{ uuid: string }>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      const uuid = message.body.uuid;
      try {
        await processSession(env, uuid);
        message.ack();
        console.log("[kb-sync] done", uuid);
      } catch (error) {
        const msg = (error as Error)?.message || String(error);
        console.error("[kb-sync] attempt", message.attempts, "failed", uuid, msg);
        if (message.attempts >= QUEUE_MAX_ATTEMPTS) {
          await recordFailure(env, uuid, msg);
          message.ack();
          console.error("[kb-sync] gave up", uuid);
        } else {
          message.retry({ delaySeconds: 60 });
        }
      }
    }
  },
};
