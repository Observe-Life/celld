// AstrBot OpenAPI 拉取通道：列表找增量 + 导出 JSONL，转成既有管线的 RawSession。
// 只认证拉取，不做任何转写/清洗——那是 Workflow 的活，handler 只做搬运。
import type { Env } from "../env";
import type { RawSession, RawMessage } from "./md";

export interface ConversationRef {
  user_id: string;
  cid: string;
  updated_at: number;
}

interface ConversationRow extends ConversationRef {
  title?: string | null;
  platform_id?: string;
  created_at?: number;
}

function apiBase(env: Env): string {
  return (env.ASTRBOT_URL || "http://astrbot:6185").replace(/\/+$/, "");
}

function authHeaders(env: Env): Record<string, string> {
  return { Authorization: `Bearer ${env.ASTRBOT_API_KEY}` };
}

export function epochToIso(value: number | undefined): string {
  if (!value) return "";
  // AstrBot 的 updated_at 是秒级 epoch（整数）。台账与实例号都消费这个字符串，
  // 用毫秒 ISO 保持跨会话可比且排序稳定。
  return new Date(value * 1000).toISOString();
}

async function listConversations(env: Env, page: number, pageSize: number): Promise<{ rows: ConversationRow[]; totalPages: number }> {
  const url = `${apiBase(env)}/api/v1/conversations?page=${page}&page_size=${pageSize}&sort_by=updated_at&sort_order=desc&include_history=false`;
  const reply = (await (await fetch(url, { headers: authHeaders(env) })).json()) as {
    status?: string;
    data?: { conversations?: ConversationRow[]; pagination?: { total_pages?: number } };
  };
  const rows = reply?.data?.conversations ?? [];
  return { rows, totalPages: Math.max(1, reply?.data?.pagination?.total_pages ?? 1) };
}

async function exportConversations(env: Env, refs: ConversationRef[]): Promise<string> {
  const reply = await fetch(`${apiBase(env)}/api/v1/conversations/export`, {
    method: "POST",
    headers: { ...authHeaders(env), "content-type": "application/json" },
    body: JSON.stringify({
      conversations: refs.map((ref) => ({ user_id: ref.user_id, cid: ref.cid })),
    }),
  });
  if (!reply.ok) throw new Error(`astrbot export ${reply.status}`);
  return await reply.text();
}

/** AstrBot 导出消息 → 既有管线消息。tool/_checkpoint/think 全部丢弃，
 *  与旧插件产出的 md 形态一致（工具调用与思考过程不进语料）。 */
function toMessages(content: unknown): RawMessage[] {
  const out: RawMessage[] = [];
  const rows = Array.isArray(content) ? content : [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const role = String((row as { role?: unknown }).role ?? "");
    if (role !== "user" && role !== "assistant") continue;
    const body = (row as { content?: unknown }).content;
    const chunks: string[] = [];
    if (typeof body === "string") {
      chunks.push(body);
    } else if (Array.isArray(body)) {
      for (const part of body) {
        if (part && typeof part === "object" && (part as { type?: unknown }).type === "text") {
          const text = (part as { text?: unknown }).text;
          if (typeof text === "string") chunks.push(text);
        }
        // 其余段类型（think/工具回执）不进语料，与旧口径一致。
      }
    }
    const text = chunks.join("\n\n").trim();
    if (text) out.push({ role, parts: [{ type: "text", text }] });
  }
  return out;
}

/** 把一轮导出 JSONL 落进既有存储：saveRaw + putMeta。返回写入的 uuid 列表。 */
async function importJsonl(env: Env, jsonl: string, platformIdOf: (ref: ConversationRef, title: string) => string): Promise<string[]> {
  const { saveRaw, putMeta, setApproved } = await import("./store");
  const written: string[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let record: {
      cid?: string;
      user_id?: string;
      title?: string | null;
      platform_id?: string;
      created_at?: number;
      updated_at?: number;
      content?: unknown;
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const uuid = record.cid ?? "";
    const messages = toMessages(record.content);
    if (!uuid || !messages.length) continue;
    const updatedAt = epochToIso(record.updated_at);
    const raw: RawSession = {
      uuid,
      conversation_id: uuid,
      title: record.title ?? "",
      platform: ((record.platform_id ?? "").split(":")[0] ?? "") ,
      created_at: epochToIso(record.created_at),
      updated_at: updatedAt,
      no_ts: true,
      messages,
    };
    await saveRaw(env.FILES, uuid, raw);
    await putMeta(env.STATE, {
      uuid,
      conversation_id: uuid,
      title: raw.title,
      platform: raw.platform,
      updated_at: updatedAt,
      pushed_at: new Date().toISOString(),
    });
    // 渠道是 AstrBot 本体（可信源），轮询导入的会话直接视为已审批：
    // 不挡在审批闸门上，否则全自动管线每来一个新会话都要人点一次。
    await setApproved(env.STATE, uuid);
    written.push(uuid);
    void platformIdOf;
  }
  return written;
}

/** 一页增量扫描：返回该页里「台账缺失或版本落后」的会话引用。 */
export async function scanPage(env: Env, page: number, pageSize = 50): Promise<{ refs: ConversationRef[]; totalPages: number }> {
  const { getLedger } = await import("./store");
  const { rows, totalPages } = await listConversations(env, page, pageSize);
  const refs: ConversationRef[] = [];
  for (const row of rows) {
    if (!row.cid) continue;
    const updatedAt = epochToIso(row.updated_at);
    const ledger = await getLedger(env.STATE, row.cid);
    if (ledger && ledger.updated_at === updatedAt) continue;
    refs.push({ user_id: row.user_id, cid: row.cid, updated_at: row.updated_at });
  }
  return { refs, totalPages };
}

/** 单会话导入：导出 JSONL → 转 RawSession → 既有存储落位 → 自动审批。 */
export async function importRef(env: Env, ref: ConversationRef): Promise<boolean> {
  const jsonl = await exportConversations(env, [ref]);
  const { saveRaw, putMeta, setApproved } = await import("./store");
  let written = false;
  for (const line of jsonl.split("\\n")) {
    if (!line.trim()) continue;
    let record: {
      cid?: string;
      title?: string | null;
      platform_id?: string;
      created_at?: number;
      updated_at?: number;
      content?: unknown;
    };
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    const uuid = record.cid ?? "";
    const messages = toMessages(record.content);
    if (!uuid || !messages.length) continue;
    const raw: RawSession = {
      uuid,
      conversation_id: uuid,
      title: record.title ?? "",
      platform: ((record.platform_id ?? "").split(":")[0] ?? ""),
      created_at: epochToIso(record.created_at),
      updated_at: epochToIso(record.updated_at),
      no_ts: true,
      messages,
    };
    await saveRaw(env.FILES, uuid, raw);
    await putMeta(env.STATE, {
      uuid,
      conversation_id: uuid,
      title: raw.title,
      platform: raw.platform,
      updated_at: raw.updated_at,
      pushed_at: new Date().toISOString(),
    });
    // 渠道是 AstrBot 本体（可信源）：轮询导入的会话直接视为已审批，不挡在闸门上。
    await setApproved(env.STATE, uuid);
    written = true;
  }
  return written;
}
