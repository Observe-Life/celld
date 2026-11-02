// kb-writer 数据通道封装（通道现驻留在 cfkit 容器内，端口 8601）
export interface BrokerConversation {
  conversation_id: string;
  uuid: string;
  platform: string;
  title: string;
  has_history: boolean;
  created_at: string;
  updated_at: string;
}

export interface BrokerPart {
  type: string;
  text?: string;
  filename?: string;
  attachment_id?: string;
  mime?: string;
  b64?: string;
  image_url?: { url?: string };
  think?: string;
  tool_calls?: Array<{ name?: string }>;
}

export interface BrokerMessage {
  ts?: string;
  role: string; // user | bot | assistant
  parts: BrokerPart[];
}

export interface BrokerMessages {
  source: "history" | "fallback";
  no_ts?: boolean;
  messages: BrokerMessage[];
}

export interface StateEntry {
  conv: string; // conversation_id (AstrBot)
  md: string; // md 文件名
  knowledge_id?: string;
  updated_at?: string;
  parse_status?: string;
  content_hash?: string;
  error?: string;
  synced_at?: string;
}

export interface SyncState {
  convs: Record<string, StateEntry>; // key = uuid
}

function url(base: string, path: string): string {
  return base.replace(/\/$/, "") + path;
}

async function jsonFetch<T>(target: string, init?: RequestInit): Promise<T> {
  const res = await fetch(target, { ...init, signal: AbortSignal.timeout(120000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`kb-writer ${res.status} ${text.slice(0, 200)}`);
  return JSON.parse(text) as T;
}

export function getState(base: string): Promise<SyncState> {
  return jsonFetch<SyncState>(url(base, "/api/state"));
}

export function setState(base: string, state: SyncState): Promise<void> {
  return jsonFetch(url(base, "/api/state"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(state),
  }).then(() => undefined);
}

export function listConversations(base: string): Promise<BrokerConversation[]> {
  return jsonFetch<{ data: BrokerConversation[] }>(url(base, "/api/conversations")).then((r) => r.data);
}

export function getMessages(base: string, id: string): Promise<BrokerMessages> {
  return jsonFetch<BrokerMessages>(url(base, `/api/messages?id=${encodeURIComponent(id)}`));
}

export async function getAttachmentBytes(
  base: string,
  attachmentId: string,
): Promise<{ mime: string; b64: string } | null> {
  const res = await fetch(url(base, `/api/attachment/${encodeURIComponent(attachmentId)}`), { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return null;
  const mime = res.headers.get("x-attachment-mime") || res.headers.get("content-type") || "application/octet-stream";
  const buffer = await res.arrayBuffer();
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return { mime, b64: btoa(binary) };
}

export async function writeMd(base: string, name: string, content: string): Promise<void> {
  const bytes = new TextEncoder().encode(content);
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  const b64 = btoa(binary);
  await jsonFetch(url(base, "/api/write"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name, b64 }),
  });
}

export async function stateUpdate(base: string, uuid: string, entry: StateEntry): Promise<void> {
  await jsonFetch(url(base, "/api/state-update"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid, entry }),
  });
}

export async function stateDelete(base: string, uuid: string): Promise<void> {
  await jsonFetch(url(base, "/api/state-delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ uuid }),
  });
}

export async function deleteMd(base: string, name: string): Promise<void> {
  await jsonFetch(url(base, "/api/delete"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
}

// 从文件夹读回 md 字节（唯一源头：上传必须以文件夹里的文件为准）
export async function readMdBytes(base: string, name: string): Promise<Uint8Array | null> {
  const res = await fetch(url(base, `/api/read?name=${encodeURIComponent(name)}`), { signal: AbortSignal.timeout(120000) });
  if (!res.ok) return null;
  return new Uint8Array(await res.arrayBuffer());
}

// 文件存在性探测（文件锚点用）：/api/read 返回 200 即存在
export async function fileExists(base: string, name: string): Promise<boolean> {
  const res = await fetch(url(base, `/api/read?name=${encodeURIComponent(name)}`), { signal: AbortSignal.timeout(30000) });
  return res.ok;
}
