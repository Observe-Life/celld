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

/**
 * 画像写入的 LLM 归类与取代判定（放在根侧，数据层保持零模型依赖）。
 * 提示词照 Graphiti 的保守约束：判错取代比放过重复伤害更大。
 */
const CLASSIFY_PROMPT = [
  "你是记忆槽位归类器。给你一条关于用户本人的陈述、可选槽位表、以及同槽位或同类别的现有记忆。",
  "任务：",
  "1) 从槽位表选最贴切的 slot（选不出填 \"\")；",
  "2) 判断新陈述与现有记忆的关系，action 取其一：",
  '   add=全新事实；noop=与某条现有记忆说的是同一件事（措辞不同也算），给 target_id；',
  "   update=明确取代某条（现有记忆因新事实不再成立），给 target_id；",
  "   conflict=与现有矛盾但证据不足以判定谁被取代；reject=敏感槽位但来源是自动推断。",
  "严格约束：",
  "- 除非新陈述明确表示「不再/改成/换了/离职/确诊为/更正为」这类变化，否则不得判 update；",
  "- 不得仅因为新陈述更晚、日期更新、或提到同一实体就判 update；",
  "- 多值槽位（兴趣、语言、饮食偏好、过敏源列表）通常应判 add 或 noop，不是 update；",
  "- 但即使是多值槽位，如果新陈述与某条现有记忆【指称同一件事】（只是更详细、更口语、或补了确认来源），必须判 noop 并给 target_id，不得判 add 造成同一事实重复堆积；只有确实是另一个不同对象才判 add；",
  "- sensitive=1 的槽位，若 origin=extracted，必须返回 reject。",
  '只输出 JSON：{"slot":"","action":"add","target_id":"","reason":""}',
].join("\n");

async function fetchJson(env: Env, path: string, body?: Record<string, unknown>): Promise<Record<string, unknown>> {
  // 分支构造：exactOptionalPropertyTypes 下不能给 headers/body 传 undefined
  const res = body
    ? await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}${path}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      }))
    : await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}${path}`));
  return (await res.json()) as Record<string, unknown>;
}

async function fetchSlots(env: Env): Promise<Array<Record<string, unknown>>> {
  const res = await env.TIMELINE.fetch(new Request(`${TIMELINE_BASE}/profile/slots`));
  const d = (await res.json()) as { slots?: Array<Record<string, unknown>> };
  return d.slots ?? [];
}

async function fetchCandidates(env: Env, slot: string, kind: string): Promise<Array<Record<string, unknown>>> {
  const res = await env.TIMELINE.fetch(new Request(
    `${TIMELINE_BASE}/profile/candidates?slot=${encodeURIComponent(slot)}&kind=${encodeURIComponent(kind)}`));
  const d = (await res.json()) as { items?: Array<Record<string, unknown>> };
  return d.items ?? [];
}

/** 关键词兜底归类：LLM 不可用时也要给出 slot，否则敏感槽位检查会被绕过（实测 503 就发生过）。 */
const SLOT_HINTS: Array<[RegExp, string]> = [
  [/过敏|忌口|不能吃/, "health.allergy"],
  [/确诊|病史|血脂|血压|血糖|用药/, "health.condition"],
  [/体检|报告/, "health.metrics"],
  [/离职|入职|跳槽|公司在|就任|兼职/, "work.company"],
  [/职业是|做.{0,6}(工程师|设计|医生|老师|运营)|岗位/, "identity.role"],
  [/我叫|称呼我|名字是/, "identity.name"],
  [/住在|城市|搬到|定居/, "location.city"],
  [/对.{0,10}感兴趣|喜欢研究|长期关注/, "interest.domain"],
  [/想买|打算买|计划买/, "interest.plan"],
  [/想吃|想去|收藏了.*餐厅|收藏了.*地方/, "diet.preference"],
  [/对象|伴侣|理想型|女朋友|男朋友/, "relation.partner_criteria"],
  [/分手|恋爱|结婚|离婚|前任/, "emotion.history"],
  [/家里|父母|孩子|老婆|老公|家人/, "family.background"],
  [/擅长|精通|会用|熟悉/, "capability.skill"],
  [/简洁|详细回答|别太长|回复风格/, "preference.answer_style"],
];

function slotByRule(content: string): string {
  for (const [re, slot] of SLOT_HINTS) {
    if (re.test(content)) return slot;
  }
  return "";
}

async function classifyWithLlm(
  env: Env, content: string, kind: string, origin: string,
): Promise<{ slot: string; action: string; target_id: string; reason: string; llm: string }> {
  // 兜底 slot 先算好：LLM 失败时用它，保证敏感槽位检查不失效
  const ruleSlot = slotByRule(content);
  const fallback = { slot: ruleSlot, action: "add", target_id: "", reason: `LLM 不可用，按关键词归入 ${ruleSlot || "free-form"}`, llm: "skipped" };
  if (!env.GEMINI_KEY) return fallback;
  const slots = await fetchSlots(env);
  // 关键：必须把现有记忆一起给模型，否则它无从判断「是否同一件事」，
  // 只会把每条新表述都判成 add（实测 T1 就是这个原因没收敛）。
  // slot 是模型的输出，所以先用规则猜一个 slot 去取候选，规则没命中就按 kind 取。
  const guessSlot = slotByRule(content);
  const cands = await fetchCandidates(env, guessSlot, kind);
  const candText = cands.length
    ? cands.map((c) => `- id=${c.id} | slot=${c.slot || "-"} | ${String(c.content).slice(0, 90)}`).join("\n")
    : "（无同类现有记忆）";
  const prompt = [
    CLASSIFY_PROMPT,
    `\n【新陈述】kind=${kind} origin=${origin} 内容：${content}`,
    `\n【槽位表】\n${slots.map((x) => `- ${x.slot} | ${x.label} | ${x.cardinality} | sensitive=${x.sensitive} | ${x.description}`).join("\n")}`,
    `\n【同类现有记忆】${candText}`,
  ].join("");
  // 免费档会 429/503 限流（实测出现过），退避重试两次仍失败才降级到规则兜底
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(`${env.GEMINI_BASE}/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.GEMINI_KEY}` },
        body: JSON.stringify({ model: env.GEMINI_MODEL || "gemini-3.1-flash-lite", messages: [{ role: "user", content: prompt }], temperature: 0 }),
      });
      if (!res.ok) {
        lastStatus = res.status;
        if ((res.status === 429 || res.status === 503) && attempt < 2) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        return { ...fallback, llm: `http${res.status}` };
      }
      const d = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const txt = String(d.choices?.[0]?.message?.content ?? "");
      const m = txt.match(/\{[\s\S]*\}/);
      if (!m) return { ...fallback, llm: "unparsed" };
      const j = JSON.parse(m[0]) as Record<string, unknown>;
      return {
        slot: String(j.slot ?? "") || ruleSlot,   // LLM 没给出也用规则兜底，敏感检查不失效
        action: String(j.action ?? "add"),
        target_id: String(j.target_id ?? ""),
        reason: String(j.reason ?? "").slice(0, 160),
        llm: "ok",
      };
    } catch (e) {
      if (attempt < 2) {
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      return { ...fallback, llm: `error:${String(e).slice(0, 60)}` };
    }
  }
  return { ...fallback, llm: `http${lastStatus || "exhausted"}` };
}

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

/**
 * 从素材文件名提取会话 uuid。rag-ferrite 的文件名由 celld 的 mdFileName() 生成为
 * `会话-<uuid>-<标题>.md`，uuid 就在名字里。
 *
 * 这是切换附带修好的一个真实缺陷：旧体系里时间轴存会话 uuid、经验通道存 weknora 文档 id，
 * 两套 id 永不相交，所以「同一 knowledge_id 的多个命中合并」这条设计在跨通道上落不了地。
 * 现在两边都能归一到会话 uuid。非会话类素材取不到，回退用文件名本身。
 */
function uuidFromSourceName(name: string): string | null {
  const m = /^会话-([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})-.+\.md$/.exec(name);
  // 用可选链而非 m[1] 直取：本实例 tsconfig 开了 noUncheckedIndexedAccess，
  // 下标访问的类型是 string | undefined，直接返回会撞 TS2322。
  return m?.[1] ?? null;
}

/** 经验知识通道：rag-ferrite 的混合检索（BM25 中文切词 + 向量 + RRF + 外接重排）。
 *
 * 与旧 weknora 通道的两点实质差别：
 *   1. 向量段可用了。weknora-lite 的向量查询在 19,046 个向量上 60 秒不返回
 *      （sqlite-vec 无 KNN 索引，退化为暴力扫描），所以当时被迫带
 *      disable_vector_match=true 只跑关键词。rag-ferrite 实测 0.17–0.79 秒全链路完成。
 *   2. 单库。没有知识库这一层，因此不再有 RECALL_KB_IDS 多库循环。
 */
async function fromCorpus(env: Env, q: string, limit: number): Promise<CpResult> {
  if (!q) return { hits: [], error: "经验通道需要 q" };
  const base = env.RAGF_URL.replace(/\/$/, "");
  const out: RecallHit[] = [];
  try {
    const res = await fetch(`${base}/api/query`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RAGF_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ query: q, limit: Math.min(limit, 50) }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { hits: out, error: `ragferrite ${res.status} ${body.slice(0, 120)}` };
    }
    const d = (await res.json()) as { results?: Array<Record<string, unknown>> };
    for (const seg of d.results ?? []) {
      const name = String(seg.source_name ?? "");
      const text = String(seg.content ?? "");
      if (!name && !text) continue;
      out.push({
        source: "corpus",
        // 归一到会话 uuid，与时间轴通道同源；取不到则用文件名兜底
        knowledge_id: uuidFromSourceName(name) ?? name,
        event_time: undefined,
        seq: seg.chunk_index == null ? undefined : Number(seg.chunk_index),
        snippet: text.slice(0, 500),
        title: name || undefined,
        score: seg.score == null ? undefined : Number(seg.score),
      });
    }
  } catch (e) {
    return { hits: out, error: String(e).slice(0, 160) };
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
        corpus_base: env.RAGF_URL,
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

    // 临时探针：验证 workerd 是否走 HTTPS_PROXY 出网（决定 LLM 判定放在哪一侧）
    if (url.pathname === "/llm/probe") {
      const key = env.GEMINI_KEY;
      if (!key) return Response.json({ ok: false, error: "未配置 GEMINI_KEY" }, { status: 400 });
      const t0 = Date.now();
      try {
        const res = await fetch(`${env.GEMINI_BASE}/chat/completions`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: env.GEMINI_MODEL || "gemini-3.1-flash-lite",
            messages: [{ role: "user", content: '只输出JSON：{"ok":true,"say":"你好"}' }],
            temperature: 0,
          }),
        });
        const text = await res.text();
        return Response.json({ ok: res.ok, status: res.status, ms: Date.now() - t0, body: text.slice(0, 400) });
      } catch (e) {
        return Response.json({ ok: false, error: String(e).slice(0, 300), ms: Date.now() - t0 }, { status: 502 });
      }
    }

    // 存量回填：给没有槽位的旧条目按关键词规则补 slot（零 LLM，不受限流影响）
    if (url.pathname === "/profile/backfill-slots" && request.method === "POST") {
      const list = await fetchJson(env, "/profile/noslot");
      const items = (list.items ?? []) as Array<Record<string, unknown>>;
      let assigned = 0;
      const detail: string[] = [];
      for (const it of items) {
        const slot = slotByRule(String(it.content ?? ""));
        if (!slot) continue;
        await fetchJson(env, "/profile/set-slot", { id: String(it.id), slot });
        assigned += 1;
        detail.push(`${slot} <= ${String(it.content ?? "").slice(0, 24)}`);
      }
      return Response.json({ ok: true, scanned: items.length, assigned, detail: detail.slice(0, 12) });
    }

    // 整理（含确定性合并）
    if (url.pathname === "/profile/consolidate" && request.method === "POST") {
      return Response.json(await fetchJson(env, "/profile/consolidate", {}));
    }

    // 画像写入：根侧先用 LLM 归类槽位并判定关系，再交给数据层执行
    if (url.pathname === "/profile/remember" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
      const content = String(body.content ?? "");
      const kind = String(body.kind ?? "preference");
      const origin = String(body.origin ?? "explicit");
      if (!content.trim()) return Response.json({ ok: false, error: "content 必填" }, { status: 400 });

      const c = await classifyWithLlm(env, content, kind, origin);
      if (c.action === "reject") {
        return Response.json({ ok: false, error: c.reason || "敏感槽位禁止自动推断写入", llm: c }, { status: 403 });
      }
      if (c.action === "noop" && c.target_id) {
        await fetchJson(env, "/profile/touch", { ids: [c.target_id] });
        return Response.json({ ok: true, deduped: true, id: c.target_id, slot: c.slot, llm: c });
      }
      const putBody: Record<string, unknown> = { kind, content, origin, slot: c.slot, scope: body.scope ?? "global" };
      if (body.importance != null) putBody.importance = body.importance;
      if (body.source_ref != null) putBody.source_ref = body.source_ref;
      if (body.valid_from != null) putBody.valid_from = body.valid_from;
      // update 与 add 都交给数据层：数据层按槽位 cardinality 决定是否关旧记录有效期
      const r = await fetchJson(env, "/profile/put", putBody);
      return Response.json({ ok: true, ...r, action: c.action, llm: c });
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
