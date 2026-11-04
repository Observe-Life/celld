// 会话同步的 Workflow 形态：一个会话一个实例，实例号 = `uuid-版本`。
//
// 与旧「队列 handler + KV 锁」形态的三点本质区别：
//   1. 等解析不再占 isolate。旧实现在 handler 里同步轮询最长 600 秒，那 600 秒一直占着
//      isolate，所以 max_concurrency=2 成了硬吞吐上限；这里改成 step.sleep + 短查询步骤，
//      等待期间实例休眠（celld 文档：A waiting instance holds no isolate）。
//   2. 转写这一步的结果持久化。旧形态一次失败会重跑整个流程、重复烧 JBB 转写费；
//      这里重放时已完成的步骤直接返回缓存结果。
//   3. 重复触发由平台去重。createBatch() 对已存在的实例号是静默跳过（源码 harness.js
//      L8792：`if (meta !== undefined && skipExisting) return { created: false }`），
//      因此不再需要 KV 锁，也一并消除了旧实现「拿不到锁就 message.ack() 丢弃消息」的静默丢数据路径。
//
// 注意：step 的 timeout 数字单位是**毫秒**（celld harness 抛错原文
// 「step "upload" timed out after 300 ms」），所以这里一律写字符串时长，避免再踩单位坑。
// 重放纯净纪律（celld 文档硬要求）：所有副作用与子请求都在 step.do 内；
// run() 里没有任何挂起超过 60 秒的非步骤代码；步骤结果只回小对象（raw/md 本体一律走 R2 重读，
// 因为步骤结果上限 1MiB，而带附件的会话原文远超它）。
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../env";
import { entriesFromSession, pushEntries } from "../lib/timeline";
import { buildConversationMd, mdFileName, type RawSession } from "../lib/md";
import {
  getLedger,
  loadMd,
  loadRaw,
  putLedger,
  saveMd,
  sha256Hex,
  type LedgerEntry,
} from "../lib/store";
import {
  checkParseOnce,
  deleteKnowledge,
  findKnowledgeBase,
  listKnowledge,
  uploadKnowledge,
} from "../lib/weknora";

export interface SessionParams {
  uuid: string;
  /** 本实例号，写进台账供 /status 查进度 */
  wf: string;
}

/** 等解析：60 轮 × 10 秒 = 600 秒，与旧 waitParse 的上限保持一致 */
const MAX_PARSE_ROUNDS = 60;
const PARSE_POLL = "10 seconds";
const MD_LIMIT = 20_000_000;

export class SessionSyncFlow extends WorkflowEntrypoint<Env, SessionParams> {
  async run(event: WorkflowEvent<SessionParams>, step: WorkflowStep) {
    const uuid = event.payload.uuid;

    // 1. 定位知识库
    const kb = await step.do(
      "find-kb",
      { retries: { limit: 2, delay: 2000 } },
      async () => {
        const found = await findKnowledgeBase(this.env);
        if (!found) throw new NonRetryableError("KB_NOT_FOUND");
        return found.id;
      },
    );

    // 2. 读原始会话：只回摘要，raw 本体留在 R2（步骤结果 ≤1MiB）
    const head = await step.do(
      "read-raw",
      { retries: { limit: 1, delay: 2000 } },
      async () => {
        const raw = await loadRaw<RawSession>(this.env.FILES, uuid);
        if (!raw) throw new NonRetryableError("RAW_MISSING");
        if (!raw.messages?.length) throw new NonRetryableError("NO_MESSAGES");
        return {
          conv: raw.conversation_id,
          updated_at: raw.updated_at ?? "",
          md: mdFileName(raw),
        };
      },
    );

    // 3. 转写 + 构建 md + 落 R2 —— 全流程最贵的一步，结果持久化后不再重烧
    const built = await step.do(
      "transcribe-and-save",
      { retries: { limit: 1, delay: 5000 }, timeout: "15 minutes" },
      async () => {
        const raw = await loadRaw<RawSession>(this.env.FILES, uuid);
        if (!raw) throw new NonRetryableError("RAW_MISSING");
        const md = await buildConversationMd(this.env, raw);
        if (md.length > MD_LIMIT) throw new NonRetryableError("MD_TOO_LARGE");
        const bytes = new TextEncoder().encode(md);
        const hash = await sha256Hex(bytes);
        await saveMd(this.env.FILES, head.md, md);
        return { hash, bytes: bytes.length };
      },
    );

    // 4. 幂等短路：台账已是同哈希且已完成，就不必再上传解析
    const needSync = await step.do("deja-vu", async () => {
      const existing = await getLedger(this.env.STATE, uuid);
      return !(
        existing &&
        existing.content_hash === built.hash &&
        existing.parse_status === "completed"
      );
    });
    if (!needSync) {
      return { uuid, skipped: "deja-vu", hash: built.hash };
    }

    // 5. 删除该会话的旧文档（副作用，必须可容忍第二次尝试）
    await step.do(
      "delete-old-docs",
      { retries: { limit: 1, delay: 2000 } },
      async () => {
        const list = await listKnowledge(this.env, kb);
        const prefix = "会话-" + uuid + "-";
        for (const doc of list.filter((k) => k.title.startsWith(prefix))) {
          try {
            await deleteKnowledge(this.env, doc.id);
          } catch {
            /* 单篇删除失败不阻断：上传会覆盖同名，台账以新 knowledge_id 为准 */
          }
        }
        return true;
      },
    );

    // 6. 上传 md，拿 knowledge_id
    const up = await step.do(
      "upload",
      { retries: { limit: 2, delay: 5000 }, timeout: "5 minutes" },
      async () => {
        const md = await loadMd(this.env.FILES, head.md);
        if (md == null) throw new NonRetryableError("MD_MISSING_AFTER_SAVE");
        const knowledgeId = await uploadKnowledge(
          this.env,
          kb,
          head.md,
          new TextEncoder().encode(md),
        );
        return { knowledgeId };
      },
    );

    // 7. 等解析：短查询步骤 + step.sleep 循环。等待期间实例休眠，不占 isolate。
    //    步骤名带轮次号，保证重放时每一步都能命中自己的缓存结果。
    let status = "pending";
    let seen = false;
    for (let round = 0; round < MAX_PARSE_ROUNDS; round += 1) {
      const probe = await step.do(
        `check-parse-${round}`,
        { retries: { limit: 1, delay: 2000 } },
        async () => checkParseOnce(this.env, kb, up.knowledgeId, seen),
      );
      status = probe.status;
      seen = probe.seen;
      if (status === "completed" || status === "missing" || status.startsWith("fail")) break;
      await step.sleep(`wait-parse-${round}`, PARSE_POLL);
    }

    // 8. 写台账（成功与失败都记：失败态会被下一轮对账重新发现，自愈语义保留）
    const entry: LedgerEntry = {
      conv: head.conv,
      md: head.md,
      knowledge_id: up.knowledgeId,
      updated_at: head.updated_at,
      parse_status: status,
      content_hash: built.hash,
      error: status === "completed" ? undefined : `PARSE_${status}`,
      synced_at: new Date().toISOString(),
      wf: event.payload.wf,
    };
    // 时间轴登记：增量场景下每轮会话处理完就推一次消息级时间。
    // 失败不阻断入库（召回是读侧增强，写侧以入库为准），但要在结果里可见。
    await step.do(
      "report-timeline",
      { retries: { limit: 1, delay: 3000 } },
      async () => {
        const raw = await loadRaw<RawSession>(this.env.FILES, uuid);
        if (!raw) return { skipped: "raw missing" };
        const items = entriesFromSession(raw, uuid, kb);
        const r = await pushEntries(this.env, items);
        return { entries: items.length, sent: r.sent, failed: r.failed.length };
      },
    );

    await step.do(
      "put-ledger",
      { retries: { limit: 2, delay: 2000 } },
      async () => {
        await putLedger(this.env.STATE, uuid, entry);
        return true;
      },
    );

    if (status !== "completed") throw new NonRetryableError("PARSE_" + status);
    return { uuid, hash: built.hash, knowledgeId: up.knowledgeId, status };
  }
}
