// 时间轴登记：把素材里的消息级时间推给 celld-knowledge-recall 的 timeline worker。
//
// 为什么在入库侧做（而不是让召回容器反推）：只有这里天然握着「谁在什么时间说了什么」，
// 反推要从正文里解析时间，脆弱且会漏。
//
// 时间格式实测：raw.messages[].ts 形如 '2026-10-31 20:10:20.529902'（UTC、空格分隔、无时区标记），
// 这里统一成 ISO8601 带 Z，保证 D1 里 event_time 可按字符串范围比较。
import type { Env } from "../env";
import type { RawSession } from "./md";

const RECALL_URL = "http://celld-knowledge-recall:8080";
/** 与 timeline worker 的 BATCH_STATEMENTS 对齐：每批条目数 */
const PUT_BATCH = 20;

export interface TimelineEntry {
  knowledge_id: string;
  kb_id: string;
  seq: number;
  source_kind: string;
  channel: string;
  subject: string;
  event_time: string;
  snippet: string;
  title: string;
  conversation_id: string;
}

/** 'YYYY-MM-DD HH:mm:ss[.ffffff]' → 'YYYY-MM-DDTHH:mm:ss[.ffffff]Z' */
export function toIso(ts: string | undefined, fallback: string): string {
  const raw = (ts ?? "").trim() || fallback;
  if (!raw) return "";
  const withT = raw.replace(" ", "T");
  return /[Zz]$/.test(withT) || withT.includes("+") ? withT : `${withT}Z`;
}

function textOf(message: RawSession["messages"][number]): string {
  const out: string[] = [];
  for (const part of message.parts ?? []) {
    // 与 md.ts 同口径：正文是 plain（旧数据可能是 text）；think/tool_call 不进时间轴
    if ((part.type === "plain" || part.type === "text") && typeof part.text === "string") out.push(part.text);
    else if (part.type === "image_url") out.push("[图片]");
  }
  return out.join(" ").replace(/\s+/g, " ").trim().slice(0, 500);
}

/** 从一份会话构造时间轴条目（每条消息一项，跳过无正文与无时间且无兜底的项）。 */
export function entriesFromSession(raw: RawSession, knowledgeId: string, kbId: string): TimelineEntry[] {
  const fallback = toIso(raw.updated_at, "");
  const items: TimelineEntry[] = [];
  raw.messages.forEach((m, i) => {
    const snippet = textOf(m);
    if (!snippet) return;
    const eventTime = toIso(m.ts, fallback);
    if (!eventTime) return;
    items.push({
      knowledge_id: knowledgeId,
      kb_id: kbId,
      seq: i,
      source_kind: "conversation",
      channel: raw.platform ?? "",
      subject: m.role === "user" ? "self" : "other",
      event_time: eventTime,
      snippet,
      title: raw.title ?? "",
      conversation_id: raw.conversation_id ?? "",
    });
  });
  return items;
}

async function post(env: Env, path: string, body: unknown): Promise<{ ok: boolean; status: number; text: string }> {
  try {
    const res = await fetch(`${RECALL_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status, text: (await res.text()).slice(0, 300) };
  } catch (e) {
    return { ok: false, status: 0, text: String(e).slice(0, 200) };
  }
}

/** 登记一批条目（调用方负责分批）。 */
export async function reportTimeline(env: Env, items: TimelineInput[]): Promise<{ ok: boolean; status: number; text: string }> {
  const r = await post(env, "/timeline/put", { items });
  return { ok: r.ok, status: r.status, text: r.text };
}

type TimelineInput = Omit<TimelineEntry, "note_time"> & { note_time?: string };

/** 逐批推送，返回统计。回填与增量登记共用这条路径。 */
export async function pushEntries(env: Env, entries: TimelineEntry[]): Promise<{ sent: number; batches: number; failed: string[] }> {
  const failed: string[] = [];
  let sent = 0;
  let batches = 0;
  for (let i = 0; i < entries.length; i += PUT_BATCH) {
    const slice = entries.slice(i, i + PUT_BATCH);
    const r = await reportTimeline(env, slice);
    batches += 1;
    if (r.ok) sent += slice.length;
    else failed.push(`batch@${i}:HTTP${r.status}:${r.text.slice(0, 120)}`);
  }
  return { sent, batches, failed };
}

/** 素材删除时同步软删，避免留下孤儿时间轴。 */
export async function forgetTimeline(env: Env, knowledgeId: string): Promise<{ ok: boolean; text: string }> {
  const r = await post(env, "/timeline/forget", { knowledge_id: knowledgeId });
  return { ok: r.ok, text: r.text };
}
