// 单会话处理（队列工人）：R2 raw → 构建md(转写失败即中止) → R2 md → 删旧 → 上传 → 等解析 → KV记账
import type { Env } from "../env";
import { buildConversationMd, mdFileName, type RawSession } from "../lib/md";
import { loadRaw, putLedger, getLedger, saveMd, sha256Hex, type LedgerEntry } from "../lib/store";
import { deleteKnowledge, findKnowledgeBase, listKnowledge, uploadKnowledge, waitParse } from "../lib/weknora";

export const MAX_ATTEMPTS = 3;

export async function processSession(env: Env, uuid: string): Promise<LedgerEntry> {
  const kb = await findKnowledgeBase(env);
  if (!kb) throw new Error("KB_NOT_FOUND");

  const raw = await loadRaw<RawSession>(env.FILES, uuid);
  if (!raw) throw new Error("RAW_MISSING");
  if (!raw.messages?.length) throw new Error("NO_MESSAGES");

  const md = await buildConversationMd(env, raw); // 转写失败会直接抛出 → 任务中止
  if (md.length > 20_000_000) throw new Error("MD_TOO_LARGE");
  const mdName = mdFileName(raw);
  const bytes = new TextEncoder().encode(md);
  const hash = await sha256Hex(bytes);

  // 幂等：台账已是同哈希且完成 → 跳过
  const existing = await getLedger(env.STATE, uuid);
  if (existing && existing.content_hash === hash && existing.parse_status === "completed") {
    console.log("[kb-sync] deja-vu skip", uuid);
    return existing;
  }

  await saveMd(env.FILES, mdName, md);
  await stepDeleteOldDocs(env, kb.id, uuid);

  const knowledgeId = await uploadKnowledge(env, kb.id, mdName, bytes);
  const parseStatus = await waitParse(env, kb.id, knowledgeId, 600000);
  if (parseStatus !== "completed") throw new Error("PARSE_" + parseStatus);

  const entry: LedgerEntry = {
    conv: raw.conversation_id, md: mdName, knowledge_id: knowledgeId,
    updated_at: raw.updated_at, parse_status: parseStatus, content_hash: hash,
    error: undefined, synced_at: new Date().toISOString(),
  };
  await putLedger(env.STATE, uuid, entry);
  return entry;
}

export async function recordFailure(env: Env, uuid: string, error: string): Promise<void> {
  try {
    const raw = await loadRaw<RawSession>(env.FILES, uuid);
    const old = await getLedger(env.STATE, uuid);
    if (raw) {
      await putLedger(env.STATE, uuid, {
        conv: raw.conversation_id, md: mdFileName(raw), knowledge_id: old?.knowledge_id,
        updated_at: raw.updated_at, parse_status: "failed", content_hash: old?.content_hash,
        error: error.slice(0, 300), synced_at: new Date().toISOString(),
      });
    }
  } catch (e) { console.error("recordFailure failed", e); }
}

async function stepDeleteOldDocs(env: Env, kbId: string, uuid: string): Promise<void> {
  const list = await listKnowledge(env, kbId);
  const prefix = "会话-" + uuid + "-";
  for (const doc of list.filter((k) => k.title.startsWith(prefix))) {
    try { await deleteKnowledge(env, doc.id); } catch {}
  }
}

export const QUEUE_MAX_ATTEMPTS = MAX_ATTEMPTS;
