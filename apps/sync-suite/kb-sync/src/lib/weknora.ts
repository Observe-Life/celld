// WeKnora REST 封装（X-API-Key 鉴权）
import type { Env } from "../env";

export interface WeknoraKnowledge {
  id: string;
  title: string;
  parse_status?: string;
  enable_status?: string;
}

export interface WeknoraKb {
  id: string;
  name: string;
}

const headers = (env: Env) => ({ "X-API-Key": env.WEKNORA_KEY });
const api = (env: Env, path: string) => `${env.WEKNORA_URL.replace(/\/$/, "")}/api/v1${path}`;

export const KB_NAME = "智能体会话";

export async function findKnowledgeBase(env: Env): Promise<WeknoraKb | null> {
  const res = await fetch(api(env, "/knowledge-bases?page=1&page_size=100"), { headers: headers(env) });
  if (!res.ok) throw new Error(`weknora kbs ${res.status}`);
  const body = JSON.parse(await res.text()) as { data?: WeknoraKb[] };
  return (body.data ?? []).find((kb) => kb.name === KB_NAME) ?? null;
}

export async function listKnowledge(env: Env, kbId: string): Promise<WeknoraKnowledge[]> {
  const out: WeknoraKnowledge[] = [];
  for (let page = 1; page < 30; page += 1) {
    const res = await fetch(api(env, `/knowledge-bases/${kbId}/knowledge?page=${page}&page_size=100`), {
      headers: headers(env),
    });
    if (!res.ok) throw new Error(`weknora list ${res.status}`);
    const body = JSON.parse(await res.text()) as { data?: WeknoraKnowledge[]; total?: number };
    const items = body.data ?? [];
    out.push(...items);
    if (out.length >= (body.total ?? 0) || items.length < 100) break;
  }
  return out;
}

export async function uploadKnowledge(env: Env, kbId: string, fileName: string, bytes: Uint8Array): Promise<string> {
  const form = new FormData();
  form.append("file", new Blob([bytes as BlobPart], { type: "text/markdown" }), fileName);
  const res = await fetch(api(env, `/knowledge-bases/${kbId}/knowledge/file`), {
    method: "POST",
    headers: headers(env),
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`weknora upload ${res.status} ${text.slice(0, 300)}`);
  const body = JSON.parse(text) as { data?: WeknoraKnowledge };
  if (!body.data?.id) throw new Error(`weknora upload no id: ${text.slice(0, 200)}`);
  return body.data.id;
}

export async function deleteKnowledge(env: Env, knowledgeId: string): Promise<void> {
  const res = await fetch(api(env, `/knowledge/${knowledgeId}`), { method: "DELETE", headers: headers(env) });
  if (!res.ok && res.status !== 404) {
    const text = await res.text();
    throw new Error(`weknora delete ${res.status} ${text.slice(0, 200)}`);
  }
}

// 等待解析完成（返回最终 parse_status）
export async function waitParse(
  env: Env,
  kbId: string,
  knowledgeId: string,
  timeoutMs = 600000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = "pending";
  let seen = false;
  while (Date.now() < deadline) {
    await sleep(5000);
    try {
      const list = await listKnowledge(env, kbId);
      const doc = list.find((k) => k.id === knowledgeId);
      if (doc) {
        seen = true;
        last = doc.parse_status || "unknown";
        if (last === "completed" || last === "failed" || last.startsWith("fail")) return last;
      } else if (seen) {
        // 曾经查到过又消失 = 真的被删除了
        return "missing";
      }
      // 从未查到：列表最终一致性延迟，继续等而不是误判
    } catch (error) {
      console.error("waitParse poll error", error);
    }
  }
  return `timeout(${last})`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
