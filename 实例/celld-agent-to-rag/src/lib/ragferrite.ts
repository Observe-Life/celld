// rag-ferrite REST 封装（Bearer 鉴权）。
//
// 与旧 weknora.ts 的三点本质区别，都是这两个软件的契约差异，不是本地偏好：
//   1. 单库。rag-ferrite 没有「知识库」这一层，所以不再有 findKnowledgeBase 这一步，
//      也不再需要 RECALL_KB_IDS 这类配置。素材标识直接落在文档名上。
//   2. 入库是异步入队：POST /api/ingest/data 只回执 queued，**不给文档 id**。
//      因此上传后必须靠文件名回查状态。
//   3. 文档 id 是整数且会随重灌变化，文件名不会。所以跨系统标识一律用文件名，
//      整数 id 只在调用当场用（删除时现查）。
import type { Env } from "../env";

export interface RagfDoc {
  id: number;
  name: string;
  status: string;
  chunk_count?: number;
  collection_id?: string;
}

const headers = (env: Env) => ({
  Authorization: `Bearer ${env.RAGF_KEY}`,
  "content-type": "application/json",
});
const api = (env: Env, path: string) => `${env.RAGF_URL.replace(/\/$/, "")}${path}`;

/**
 * 从素材文件名提取会话 uuid，用于与时间轴（记忆知识）对齐。
 *
 * 这是切换附带的一个真实收益：旧体系里时间轴存会话 uuid、经验通道存 weknora 文档 id，
 * 两边永远对不上，设计文档说的「同一 knowledge_id 的多个命中合并」跨通道落不了地。
 * rag-ferrite 的文件名由 mdFileName() 生成为 `会话-<uuid>-<标题>.md`，uuid 就在名字里。
 * 非会话类素材取不到，返回 null，由调用方回退用文件名本身。
 */
export function uuidFromName(name: string): string | null {
  const m = /^会话-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-.+\.md$/.exec(name);
  // 可选链而非 m[1] 直取：tsconfig 开了 noUncheckedIndexedAccess，
  // 下标访问类型是 string | undefined，直接返回会撞 TS2322。
  return m?.[1] ?? null;
}

export async function listDocuments(env: Env): Promise<RagfDoc[]> {
  const res = await fetch(api(env, "/api/documents"), { headers: headers(env) });
  if (!res.ok) throw new Error(`ragf list ${res.status}`);
  const body = (await res.json()) as { files?: RagfDoc[] };
  return body.files ?? [];
}

export async function findDocument(env: Env, name: string): Promise<RagfDoc | null> {
  const docs = await listDocuments(env);
  return docs.find((d) => d.name === name) ?? null;
}

/** 入库一份 md 正文。异步入队，不返回 id；完成与否由 checkStatusOnce 判定。 */
export async function uploadDocument(env: Env, name: string, text: string): Promise<void> {
  const res = await fetch(api(env, "/api/ingest/data"), {
    method: "POST",
    headers: headers(env),
    body: JSON.stringify({ source: name, content: text }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`ragf upload ${res.status} ${t.slice(0, 200)}`);
  }
}

/** 按文件名删除。查不到即视为已删除（幂等，容忍重试与重复下架）。 */
export async function deleteDocument(env: Env, name: string): Promise<void> {
  const doc = await findDocument(env, name);
  if (!doc) return;
  const res = await fetch(api(env, `/api/documents/${doc.id}`), {
    method: "DELETE",
    headers: headers(env),
  });
  if (!res.ok && res.status !== 404) {
    const t = await res.text().catch(() => "");
    throw new Error(`ragf delete ${res.status} ${t.slice(0, 200)}`);
  }
}

/**
 * 单次查询解析状态。等待由 Workflow 的 step.sleep 承担，不占 isolate。
 *
 * 状态口径与旧实现保持一致，便于 session-sync 的判定逻辑不动：
 *   completed  就绪（rag-ferrite 入库完成后才出现在 documents 里）
 *   pending    队列里还没轮到
 *   missing    曾经查到过又消失 = 真的被删了
 *   poll-error 查询本身失败
 * 「查不到」既可能是尚未开始也可能是已删除，靠 seenBefore 区分。
 */
export async function checkStatusOnce(
  env: Env,
  name: string,
  seenBefore: boolean,
): Promise<{ status: string; seen: boolean }> {
  try {
    const doc = await findDocument(env, name);
    if (doc) return { status: doc.status || "unknown", seen: true };
    if (seenBefore) return { status: "missing", seen: true };
    return { status: "pending", seen: false };
  } catch (error) {
    console.error("checkStatusOnce error", error);
    return { status: "poll-error", seen: seenBefore };
  }
}
