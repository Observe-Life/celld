// 知识召回闸门（本容器的根，对外唯一入口）
//
// P1 阶段：先把「记忆知识（时间轴）」通道打通，「经验知识（素材质量召回）」通道先能出结果，
// 配比与融合在 P3 接入。四类知识的落位见 仓库根【设计】知识召回体系.md。
import type { Env } from "./env";

interface TlResult { hits: RecallHit[]; mode: string; error: string | undefined }
interface PfResult { resident: string[]; situational: string[]; ids: string[]; pending_count: number; error: string | undefined }
interface CpResult { hits: RecallHit[]; error: string | undefined }

interface RecallHit {
  source: "timeline" | "corpus";
  knowledge_id: string;
  event_time: string | undefined;
  seq: number | undefined;
  snippet: string | undefined;
  title: string | undefined;
  score: number | undefined;
}

const TIMELINE_BASE = "http://internal";

/** 每通道取多少条。0 表示本轮不用这个通道。 */
interface Weights { timeline: number; profile: number; corpus: number }
const SKIP_TL: TlResult = { hits: [], mode: "skipped", error: undefined };
const SKIP_PF: PfResult = { resident: [], situational: [], ids: [], pending_count: 0, error: undefined };
const SKIP_CP: CpResult = { hits: [], error: undefined };

/**
 * 场景配比规则（用户决策 Q-d：规则默认 + Agent 可用 mode 覆盖）。
 * 规则表放在服务端而不是插件里，将来接 IM 或别的调用方不用重写。
 */
const MEMORY_WORDS = ["之前", "上次", "去年", "今年", "还记得", "我说过", "我提过", "收藏", "哪天", "什么时候", "最近", "第一次", "当时", "上个", "那张", "那部"];
const PROFILE_WORDS = ["我的病", "我患", "我对", "我过敏", "我喜欢", "我不喜欢", "我对象", "我家", "我的保险", "我的体检", "偏好", "习惯", "擅长", "我在找", "我想买", "想去"];
const CORPUS_WORDS = ["怎么", "如何", "为什么", "原理", "方案", "配置", "报错", "部署", "实现", "医案", "方剂", "诊断", "对比", "评测", "源码", "用法", "步骤"];

function planWeights(q: string, mode: string): Weights {
  if (mode === "memory") return { timeline: 8, profile: 2, corpus: 2 };
  if (mode === "profile") return { timeline: 2, profile: 6, corpus: 2 };
  if (mode === "corpus") return { timeline: 2, profile: 2, corpus: 8 };
  if (mode === "mixed") return { timeline: 5, profile: 4, corpus: 5 };
  const has = (list: string[]) => list.some((w) => q.includes(w));
  const m = has(MEMORY_WORDS) ? 1 : 0;
  const p = has(PROFILE_WORDS) ? 1 : 0;
  const c = has(CORPUS_WORDS) ? 1 : 0;
  if (p && !m && !c) return { timeline: 3, profile: 8, corpus: 3 };
  if (m && !p && !c) return { timeline: 8, profile: 3, corpus: 3 };
  if (c && !m && !p) return { timeline: 2, profile: 2, corpus: 8 };
  if (m && p) return { timeline: 6, profile: 6, corpus: 3 };
  // 默认：经验为主，记忆与画像兜底
  return { timeline: 3, profile: 3, corpus: 6 };
}

/** 画像通道：经数据 worker 取常驻块 + 按题命中。 */
async function fromProfile(env: Env, q: string, limit: number): Promise<PfResult> {
  try {
    const res = await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}/profile/recall?q=${encodeURIComponent(q)}&limit=${limit}`));
    const d = (await res.json()) as {
      ok?: boolean; error?: string; resident?: string[]; situational?: string[]; ids?: string[]; pending_count?: number;
    };
    if (!d.ok) return { resident: [], situational: [], ids: [], pending_count: 0, error: d.error ?? "profile not ok" };
    return { resident: d.resident ?? [], situational: d.situational ?? [], ids: d.ids ?? [], pending_count: d.pending_count ?? 0, error: undefined };
  } catch (e) {
    return { resident: [], situational: [], ids: [], pending_count: 0, error: String(e).slice(0, 160) };
  }
}

interface Block { type: string; text: string; time: string; source: string }

/** 融合顺序：画像（懂我）→ 记忆（时间序）→ 经验（质量序）。同 knowledge_id 的记忆条目合并。 */
function assemble(pf: Awaited<ReturnType<typeof fromProfile>>,
                  tl: Awaited<ReturnType<typeof fromTimeline>>,
                  cp: Awaited<ReturnType<typeof fromCorpus>>): Block[] {
  const out: Block[] = [];
  for (const line of pf.resident) out.push({ type: "profile", text: line, time: "", source: "" });
  for (const line of pf.situational) out.push({ type: "profile_hit", text: line, time: "", source: "" });
  const seenDoc = new Set<string>();
  for (const h of tl.hits) {
    const key = `${h.knowledge_id}`;
    if (seenDoc.has(key)) continue;
    seenDoc.add(key);
    out.push({
      type: "memory",
      text: h.snippet ?? "",
      time: h.event_time ?? "",
      source: h.knowledge_id,
    });
  }
  for (const h of cp.hits) {
    if (seenDoc.has(h.knowledge_id)) continue;
    seenDoc.add(h.knowledge_id);
    out.push({ type: "experience", text: h.snippet ?? "", time: "", source: h.knowledge_id });
  }
  return out;
}

/** 预算裁剪：按字符数截断，画像优先保留（它每轮都该在）。 */
function fitBudget(blocks: Block[], budget: number): Block[] {
  const out: Block[] = [];
  let used = 0;
  for (const b of blocks) {
    const line = b.text.slice(0, 500);
    if (!line) continue;
    const cost = line.length + (b.time ? 20 : 0);
    if (used + cost > budget) continue;
    out.push({ ...b, text: line });
    used += cost;
  }
  return out;
}

/** 渲染成注入文本：带类型标签与时间标注，让模型知道哪条是几时的。 */
function render(blocks: Block[]): string {
  if (!blocks.length) return "";
  const head = "以下是从你的知识库召回的相关内容（记忆条目带时间，注意时效）：";
  const lines = blocks.map((b) => {
    // 画像条目在数据层已带 [kind] 前缀（profile/preference/…），这里不再叠一层标签
    if (b.type === "profile" || b.type === "profile_hit") return `- ${b.text}`;
    const tag = b.type === "memory" ? "记忆" : "经验";
    return b.time ? `- [${tag} ${b.time.slice(0, 10)}] ${b.text}` : `- [${tag}] ${b.text}`;
  });
  return `${head}\n${lines.join("\n")}`;
}



async function fromTimeline(
  env: Env,
  q: string,
  since: string,
  until: string,
  limit: number,
  kind: string,
  subject: string,
): Promise<TlResult> {
  const p = new URLSearchParams({ q, limit: String(limit) });
  if (since) p.set("since", since);
  if (until) p.set("until", until);
  if (kind) p.set("source_kind", kind);
  if (subject) p.set("subject", subject);
  try {
    const res = await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}/timeline/query?${p.toString()}`));
    const d = (await res.json()) as {
      ok?: boolean; mode?: string; error?: string;
      hits?: Array<Record<string, string | number | null>>;
    };
    if (!d.ok) return { hits: [], mode: "unavailable", error: d.error ?? "timeline not ok" };
    const hits: RecallHit[] = (d.hits ?? []).map((h) => ({
      source: "timeline",
      knowledge_id: String(h.knowledge_id ?? ""),
      event_time: h.event_time == null ? undefined : String(h.event_time),
      seq: h.seq == null ? undefined : Number(h.seq),
      snippet: h.snippet == null ? undefined : String(h.snippet),
      title: h.title == null ? undefined : String(h.title),
      score: undefined,
    }));
    return { hits, mode: d.mode ?? "unknown", error: undefined };
  } catch (e) {
    return { hits: [], mode: "error", error: String(e).slice(0, 160) };
  }
}

/** 经验知识通道：weknora-lite 的混合检索。
 *
 * 实测约束（2026-11-04）：weknora-lite 的向量段在 19,046 个向量上 60 秒不返回
 * （sqlite-vec 无 KNN 索引，退化为暴力扫描），关键词段 0.058 秒。
 * 所以这里默认 disable_vector_match=true 先保证可用，向量段等 weknora 侧修好后
 * 由 RECALL_CORPUS_VECTOR=1 打开。另外 hybrid-search 只接受 POST + JSON body，
 * GET 会报 "Invalid request parameters / EOF"。
 */
async function fromCorpus(env: Env, q: string, limit: number): Promise<CpResult> {
  const kbIds = env.RECALL_KB_IDS.split(",").map((s) => s.trim()).filter(Boolean);
  if (!kbIds.length) return { hits: [], error: "未配置 RECALL_KB_IDS，经验通道跳过" };
  if (!q) return { hits: [], error: "经验通道需要 q" };
  const base = env.WEKNORA_URL.replace(/\/$/, "");
  const useVector = env.RECALL_CORPUS_VECTOR === "1";
  const out: RecallHit[] = [];
  for (const kb of kbIds) {
    try {
      const res = await fetch(`${base}/api/v1/knowledge-bases/${encodeURIComponent(kb)}/hybrid-search`, {
        method: "POST",
        headers: { "X-API-Key": env.WEKNORA_KEY, "content-type": "application/json" },
        body: JSON.stringify({
          query_text: q,
          match_count: Math.min(limit, 50),
          disable_vector_match: !useVector,
        }),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { hits: out, error: `weknora ${res.status} ${body.slice(0, 120)}` };
      }
      const d = (await res.json()) as { data?: Array<Record<string, unknown>> };
      for (const seg of d.data ?? []) {
        const kid = String(seg.knowledge_id ?? seg.id ?? "");
        const text = String(seg.content ?? seg.snippet ?? seg.text ?? "");
        if (!kid && !text) continue;
        out.push({
          source: "corpus",
          knowledge_id: kid,
          event_time: undefined,
          seq: undefined,
          snippet: text.slice(0, 500),
          title: seg.knowledge_title == null ? undefined : String(seg.knowledge_title),
          score: seg.score == null ? undefined : Number(seg.score),
        });
      }
    } catch (e) {
      return { hits: out, error: String(e).slice(0, 160) };
    }
  }
  return { hits: out, error: undefined };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "knowledge-recall",
        role: "root",
        channels: ["timeline", "corpus"],
        kb_ids: env.RECALL_KB_IDS.split(",").filter(Boolean).length,
      });
    }

    if (url.pathname === "/recall") {
      const q = url.searchParams.get("q") ?? "";
      const since = url.searchParams.get("since") ?? "";
      const until = url.searchParams.get("until") ?? "";
      const kind = url.searchParams.get("source_kind") ?? "";
      const subject = url.searchParams.get("subject") ?? "";
      const budget = Math.min(Math.max(Number.parseInt(url.searchParams.get("budget") ?? "6000", 10) || 6000, 500), 12000);
      const forced = url.searchParams.get("mode") ?? "auto";   // auto|memory|profile|corpus|mixed

      if (!q && !since && !until) {
        return Response.json({ ok: false, error: "需要 q / since / until 至少一个条件" }, { status: 400 });
      }

      const weights = planWeights(q, forced);
      // 三通道并行；任一失败只降级、不阻断其余（degraded 里如实记录）
      const [tl, pf, cp] = await Promise.all([
        weights.timeline > 0 ? fromTimeline(env, q, since, until, weights.timeline, kind, subject) : Promise.resolve(SKIP_TL),
        weights.profile > 0 ? fromProfile(env, q, weights.profile) : Promise.resolve(SKIP_PF),
        weights.corpus > 0 ? fromCorpus(env, q, weights.corpus) : Promise.resolve(SKIP_CP),
      ]);

      const degraded: string[] = [];
      if (tl.error) degraded.push(`timeline:${tl.error}`);
      if (pf.error) degraded.push(`profile:${pf.error}`);
      if (cp.error) degraded.push(`corpus:${cp.error}`);

      const blocks = assemble(pf, tl, cp);
      const fitted = fitBudget(blocks, budget);
      return Response.json({
        ok: true,
        query: { q, since, until, kind, subject },
        mode: forced,
        weights_used: weights,
        degraded,
        blocks: fitted,
        chars: fitted.reduce((a, b) => a + b.text.length, 0),
        text: render(fitted),
      });
    }

    // 显式转发给 cohosted 数据 worker：celld 里外部请求只进根，
    // 所以别的容器（如 celld-agent-to-rag）要写时间轴，必须走这里的转发路由，
    // 不能直接命中 timeline worker 的路径（那样只会得到 404）。
    // 只转发这四条，不做通配穿透，避免把数据 worker 变成公网可达。
    if ((url.pathname.startsWith("/timeline/") || url.pathname.startsWith("/profile/")) && env.TIMELINE) {
      try {
        const target = `${TIMELINE_BASE}${url.pathname}${url.search}`;
        const headers = { "content-type": "application/json" };
        // 分支构造而不是给 body 传 undefined：exactOptionalPropertyTypes 下
        // 「可选属性」不接受显式 undefined（scheduler 那条存量 TS2379 就是同一个坑）。
        const passthrough = request.method !== "GET" && request.method !== "HEAD";
        const inner = passthrough
          ? new Request(target, { method: request.method, headers, body: request.body })
          : new Request(target, { method: request.method, headers });
        const res = await env.TIMELINE.fetch(inner);
        return new Response(res.body, { status: res.status, headers: { "content-type": "application/json" } });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 200) }, { status: 502 });
      }
    }

    // 供调用方做对账查看（根上的别名）
    if (url.pathname === "/reconcile") {
      try {
        const res = await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}/timeline/reconcile`));
        const d = (await res.json()) as Record<string, unknown>;
        return Response.json({ ok: true, ...d });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 200) }, { status: 500 });
      }
    }

    return new Response("not found", { status: 404 });
  },

  // 本实例是根，cron 在这里才会触发（celld 限制：cohosted worker 的 cron 永不运行）
  async scheduled(controller: unknown, env: Env): Promise<void> {
    const cron = (controller as { cron?: string })?.cron ?? "";
    try {
      const res = await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}/timeline/reconcile`));
      const d = await res.json();
      console.log("[knowledge-recall] scheduled", JSON.stringify({ cron, reconcile: d }));
    } catch (e) {
      console.error("[knowledge-recall] scheduled reconcile failed", String(e).slice(0, 200));
    }
  },
};
