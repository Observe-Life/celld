// CF 原生存储层：台账在 KV，会话原始数据与 md 在 R2。不再依赖任何外部通道。
export interface LedgerEntry {
  conv: string;
  md: string;
  knowledge_id?: string | undefined;
  updated_at?: string | undefined;
  parse_status?: string | undefined;
  content_hash?: string | undefined;
  error?: string | undefined;
  synced_at?: string | undefined;
  /** 最近一次处理的 Workflow 实例号（uuid-版本），用于查进度：GET /status?uuid= */
  wf?: string | undefined;
}

export interface SessionMeta {
  uuid: string;
  conversation_id: string;
  title: string;
  platform: string;
  updated_at: string;
  pushed_at: string;
}

const LEDGER = (uuid: string) => `ledger:${uuid}`;
const META = (uuid: string) => `session:${uuid}`;

export async function putLedger(kv: KVNamespace, uuid: string, e: LedgerEntry): Promise<void> {
  await kv.put(LEDGER(uuid), JSON.stringify(e));
}
export async function getLedger(kv: KVNamespace, uuid: string): Promise<LedgerEntry | null> {
  const v = await kv.get(LEDGER(uuid));
  return v ? (JSON.parse(v) as LedgerEntry) : null;
}
export async function delLedger(kv: KVNamespace, uuid: string): Promise<void> {
  await kv.delete(LEDGER(uuid));
}
export async function putMeta(kv: KVNamespace, m: SessionMeta): Promise<void> {
  await kv.put(META(m.uuid), JSON.stringify(m));
}
export async function listMetas(kv: KVNamespace): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  let cursor: string | null = null;
  while (true) {
    const opts: KVNamespaceListOptions = { prefix: "session:" };
    if (cursor) opts.cursor = cursor;
    const page = await kv.list(opts);
    for (const key of page.keys) {
      const v = await kv.get(key.name);
      if (v) out.push(JSON.parse(v) as SessionMeta);
    }
    if (page.list_complete) break;
    cursor = page.cursor ?? null;
  }
  return out;
}

export async function saveRaw(r2: R2Bucket, uuid: string, payload: unknown): Promise<void> {
  await r2.put(`raw/${uuid}.json`, JSON.stringify(payload));
}
export async function loadRaw<T = unknown>(r2: R2Bucket, uuid: string): Promise<T | null> {
  const obj = await r2.get(`raw/${uuid}.json`);
  return obj ? ((await obj.json()) as T) : null;
}
export async function saveMd(r2: R2Bucket, name: string, text: string): Promise<void> {
  await r2.put(`md/${name}`, text);
}
export async function loadMd(r2: R2Bucket, name: string): Promise<string | null> {
  const obj = await r2.get(`md/${name}`);
  return obj ? await obj.text() : null;
}
export async function delMd(r2: R2Bucket, name: string): Promise<void> {
  await r2.delete(`md/${name}`);
}
export async function listMd(r2: R2Bucket): Promise<string[]> {
  const out: string[] = [];
  let cursor = "";
  while (true) {
    const page = await r2.list({ prefix: "md/", ...(cursor ? { cursor } : {}) });
    for (const o of page.objects) out.push(o.key.slice(3));
    if (!page.truncated) break;
    cursor = page.cursor ?? "";
  }
  return out;
}
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// 按会话单飞锁：防同一 uuid 被并发消费互相删档（2026-11-02 竞态修复）
export async function setApproved(kv: KVNamespace, uuid: string): Promise<void> {
  await kv.put("approved:" + uuid, "1");
}
export async function isApproved(kv: KVNamespace, uuid: string): Promise<boolean> {
  return (await kv.get("approved:" + uuid)) === "1";
}
export async function clearApproved(kv: KVNamespace, uuid: string): Promise<void> {
  await kv.delete("approved:" + uuid);
}

export async function delMeta(kv: KVNamespace, uuid: string): Promise<void> {
  await kv.delete(META(uuid));
}
export async function delRaw(r2: R2Bucket, uuid: string): Promise<void> {
  await r2.delete(`raw/${uuid}.json`);
}

export async function sha256HexStr(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
