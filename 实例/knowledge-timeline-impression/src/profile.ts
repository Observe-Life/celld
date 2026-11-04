// 画像知识（以个人画像、偏好为中心）的数据层。
//
// 取代机制的调研依据（2026-11-04，四家一手资料）：
//   · xopc.ai：「值不是身份的一部分」——槽位由 (主体, 属性, 范围) 决定；单值/多值写在槽位定义里
//   · Zep/Graphiti：取代不删数据，旧事实 invalid_at=新事实 valid_at、expired_at=now，并重述为「曾经是…」
//   · Mem0 v3：放弃 UPDATE 路径，靠检索排序让当前真相胜出（因为取代判定本身不可靠）
//   · xopc：「newer ≠ more authoritative」——推断不能覆盖用户显式声明
// 所以这里的规则是：槽位化取代（确定性）+ 显式优先 + 只关有效期不删数据。
import type { Env } from "./env";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS profile_items (
  id             TEXT PRIMARY KEY,
  kind           TEXT NOT NULL,
  content        TEXT NOT NULL,
  topic          TEXT NOT NULL DEFAULT '',
  normalized_key TEXT NOT NULL DEFAULT '',
  importance     INTEGER NOT NULL DEFAULT 3,
  origin         TEXT NOT NULL DEFAULT 'explicit',
  status         TEXT NOT NULL DEFAULT 'active',
  valid_from     TEXT,
  invalid_at     TEXT,
  expires_at     TEXT,
  superseded_by  TEXT,
  source_ref     TEXT,
  last_used_at   TEXT,
  use_count      INTEGER NOT NULL DEFAULT 0,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_slots (
  slot        TEXT PRIMARY KEY,
  label       TEXT NOT NULL DEFAULT '',
  cardinality TEXT NOT NULL DEFAULT 'single',
  sensitive   INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS profile_tombstones (
  fingerprint    TEXT PRIMARY KEY,
  normalized_key TEXT NOT NULL DEFAULT '',
  reason         TEXT NOT NULL DEFAULT '',
  created_at     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS profile_topics (
  normalized_key TEXT PRIMARY KEY,
  topic          TEXT NOT NULL DEFAULT '',
  hits           INTEGER NOT NULL DEFAULT 0,
  last_seen_at   TEXT,
  promoted_at    TEXT
);
CREATE TABLE IF NOT EXISTS profile_affinity (
  knowledge_id TEXT PRIMARY KEY,
  hits         INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT
);
`;

/** 迁移只进不退：加列用 ALTER，重复执行时忽略「列已存在」。 */
const ADD_COLUMNS = [
  "ALTER TABLE profile_items ADD COLUMN slot TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE profile_items ADD COLUMN scope TEXT NOT NULL DEFAULT 'global'",
  "ALTER TABLE profile_items ADD COLUMN content_hash TEXT NOT NULL DEFAULT ''",
  "ALTER TABLE profile_items ADD COLUMN expired_at TEXT",
  "ALTER TABLE profile_items ADD COLUMN supersedes TEXT",
];

/** 受控槽位表。cardinality=multi 的永不取代；sensitive=1 的禁止自动推断写入。 */
const SLOTS: Array<[string, string, string, number, string]> = [
  ["identity.name", "姓名", "single", 0, "用户希望被称呼的名字"],
  ["identity.role", "职业身份", "single", 0, "当前职业/岗位/行业"],
  ["work.company", "当前单位", "single", 0, "现在就职的公司或组织"],
  ["health.allergy", "过敏源", "multi", 1, "食物/药物/环境过敏，含确认来源"],
  ["health.condition", "健康状况", "multi", 1, "已确诊疾病、长期症状、用药"],
  ["health.metrics", "体检指标", "single", 1, "最近一次体检的关键结论"],
  ["diet.dislike", "饮食禁忌", "multi", 0, "不吃/讨厌的食物"],
  ["diet.preference", "饮食偏好", "multi", 0, "喜欢吃的菜系、餐厅类型"],
  ["preference.answer_style", "回答风格", "single", 0, "简洁/详细、格式偏好"],
  ["preference.channel", "联系偏好", "single", 0, "偏好的通知与沟通方式"],
  ["interest.domain", "长期兴趣", "multi", 0, "持续关注的领域与主题"],
  ["interest.plan", "近期打算", "multi", 0, "想看/想买/想去等未完成意向"],
  ["family.background", "家庭背景", "multi", 1, "家庭成员、居住情况"],
  ["emotion.history", "情感经历", "multi", 1, "伴侣、关系状态相关事实"],
  ["relation.partner_criteria", "理想型", "multi", 1, "对伴侣的期望条件"],
  ["location.city", "所在城市", "single", 0, "当前常驻城市"],
  ["capability.skill", "擅长能力", "multi", 0, "会用的技术、擅长的领域"],
];

const TTL_DAYS: Record<string, number> = {
  task: 2, event: 7, preference: 60, relation: 90, fact: 180, profile: 3650, interest: 3650,
};
const BLOCK_CHARS = 900;
const RECALL_CHARS = 600;
const RECALL_MAX_ITEMS = 5;
const INTEREST_HITS = 3;

export interface ProfileInput {
  kind: string;
  content: string;
  slot?: string;
  scope?: string;
  topic?: string;
  normalized_key?: string;
  importance?: number;
  origin?: string;
  source_ref?: string;
  valid_from?: string;
  expires_in_days?: number;
}

function isoNow(): string { return new Date().toISOString(); }

/** 规范化：去空白与常见标点、统一小写。用于精确重复抑制（Mem0 的 MD5 思路）。 */
function normalizeText(s: string): string {
  return s.toLowerCase().replace(/[\s，。、；：！？"'`（）()\[\]{}<>~@#$%^&*_+=|\\-]/g, "");
}
function contentHash(s: string): string {
  const n = normalizeText(s);
  let h = 2166136261;
  for (let i = 0; i < n.length; i += 1) { h ^= n.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function fingerprint(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i += 1) { h ^= content.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}
function expiryFor(kind: string, importance: number, useCount: number, override?: number): string {
  const days = override ?? TTL_DAYS[kind] ?? 30;
  const boost = 1 + Math.max(0, importance - 3) * 0.5 + useCount * 0.1;
  return new Date(Date.now() + days * boost * 86_400_000).toISOString();
}

let migrated = false;
async function ensureSchema(env: Env): Promise<void> {
  if (migrated) return;
  await env.DB.exec(SCHEMA);
  for (const sql of ADD_COLUMNS) {
    try { await env.DB.exec(sql); } catch { /* 列已存在，幂等跳过 */ }
  }
  const ins = env.DB.prepare(
    "INSERT OR REPLACE INTO profile_slots (slot, label, cardinality, sensitive, description) VALUES (?,?,?,?,?)");
  await env.DB.batch(SLOTS.map(([a, b, c, d, e]) => ins.bind(a, b, c, d, e)));
  migrated = true;
}

export async function listSlots(env: Env): Promise<Array<Record<string, unknown>>> {
  await ensureSchema(env);
  const r = await env.DB.prepare("SELECT slot, label, cardinality, sensitive, description FROM profile_slots ORDER BY slot")
    .all<Record<string, unknown>>();
  return r.results;
}

/**
 * 写入画像。三层判定顺序（全部确定性优先，LLM 只负责给 slot）：
 *   1) 墓碑抑制：删过的内容不再写回
 *   2) 精确重复：规范化后同 hash → NOOP，只更新观察时间
 *   3) 槽位取代：单值槽位下旧记录关有效期（不删），多值槽位只共存
 */
async function putProfile(env: Env, input: ProfileInput) {
  const content = input.content.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!content) return { ok: false, error: "empty content" };
  const origin = input.origin ?? "explicit";
  const slot = (input.slot ?? "").trim();
  const scope = input.scope ?? "global";
  const now = isoNow();

  const fp = fingerprint(content);
  const tomb = await env.DB.prepare("SELECT fingerprint FROM profile_tombstones WHERE fingerprint = ?")
    .bind(fp).first<string>();
  if (tomb != null) return { ok: true, skipped: "tombstoned", fingerprint: fp };

  // 敏感槽位禁止自动推断写入（用户决策：只许亲口说）
  if (slot) {
    const def = await env.DB.prepare("SELECT cardinality, sensitive FROM profile_slots WHERE slot = ?")
      .bind(slot).first<{ cardinality: string; sensitive: number }>();
    if (def && def.sensitive === 1 && origin === "extracted") {
      return { ok: false, error: `敏感槽位 ${slot} 禁止自动推断写入，需用户明确声明` };
    }
  }

  const hash = contentHash(content);
  const dup = await env.DB.prepare(
    "SELECT id FROM profile_items WHERE status='active' AND slot = ? AND scope = ? AND content_hash = ? LIMIT 1",
  ).bind(slot, scope, hash).first<string>();
  if (dup != null) {
    await env.DB.prepare("UPDATE profile_items SET updated_at=?, last_used_at=? WHERE id=?")
      .bind(now, now, dup).run();
    return { ok: true, id: dup, deduped: true, reason: "同内容重复，仅更新观察时间" };
  }

  const id = `${slot || input.kind}:${Date.now().toString(36)}`;
  const status = origin === "extracted" ? "pending" : "active";
  const stmts = [
    env.DB.prepare(
      `INSERT INTO profile_items
       (id, kind, content, topic, normalized_key, importance, origin, status,
        valid_from, invalid_at, expires_at, superseded_by, source_ref, last_used_at,
        use_count, created_at, updated_at, slot, scope, content_hash, expired_at, supersedes)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NULL)`,
    ).bind(
      id, input.kind, content, input.topic ?? "", (input.normalized_key ?? slot) || "",
      Math.min(Math.max(input.importance ?? 3, 1), 5), origin, status,
      input.valid_from ?? now, null, expiryFor(input.kind, input.importance ?? 3, 0, input.expires_in_days),
      null, input.source_ref ?? null, null, 0, now, now, slot, scope, hash, null,
    ),
  ];

  // 单值槽位取代：旧记录关有效期（世界时间用新事实的 valid_from），标 superseded，不删除
  if (status === "active" && slot) {
    const def = await env.DB.prepare("SELECT cardinality FROM profile_slots WHERE slot = ?")
      .bind(slot).first<{ cardinality: string }>();
    if ((def?.cardinality ?? "single") === "single") {
      const olds = await env.DB.prepare(
        "SELECT id, content FROM profile_items WHERE slot=? AND scope=? AND status='active' AND id <> ?",
      ).bind(slot, scope, id).all<{ id: string; content: string }>();
      for (const o of olds.results) {
        stmts.push(env.DB.prepare(
          `UPDATE profile_items
           SET status='superseded', superseded_by=?, invalid_at=?, expired_at=?, updated_at=?,
               content = '曾记录：' || substr(content,1,180)
           WHERE id = ?`,
        ).bind(id, input.valid_from ?? now, now, now, o.id));
        stmts.push(env.DB.prepare("UPDATE profile_items SET supersedes=? WHERE id=?").bind(o.id, id));
      }
      if (olds.results.length) {
        return { ok: true, id, status, slot, superseded: olds.results.map((x) => x.id) };
      }
    }
  }
  await env.DB.batch(stmts);
  return { ok: true, id, status, kind: input.kind, slot: slot || "(free-form)" };
}

/** 召回：只取当前有效（invalid_at IS NULL），显式声明优先于推断，再按新近度与重要度。 */
async function recallProfile(env: Env, q: string) {
  await ensureSchema(env);
  const now = isoNow();
  const resident = await env.DB.prepare(
    `SELECT kind, content, importance, origin, valid_from FROM profile_items
     WHERE status='active' AND invalid_at IS NULL
       AND kind IN ('profile','preference','interest')
       AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY CASE origin WHEN 'extracted' THEN 1 ELSE 0 END, importance DESC, updated_at DESC
     LIMIT 20`,
  ).bind(now).all<{ kind: string; content: string }>();

  let situational: Array<{ kind: string; content: string }> = [];
  const words = q.trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  if (words.length) {
    const or = words.map(() => "(content LIKE ? OR topic LIKE ?)").join(" OR");
    const args: string[] = [];
    for (const w of words) args.push(`%${w}%`, `%${w}%`);
    const r = await env.DB.prepare(
      `SELECT kind, content FROM profile_items
       WHERE status='active' AND invalid_at IS NULL AND kind IN ('fact','task')
         AND (expires_at IS NULL OR expires_at > ?) AND ${or}
       ORDER BY CASE origin WHEN 'extracted' THEN 1 ELSE 0 END, importance DESC, updated_at DESC
       LIMIT ${RECALL_MAX_ITEMS}`,
    ).bind(now, ...(args as never[])).all<{ kind: string; content: string }>();
    situational = r.results;
  }

  const fill = (rows: Array<{ content: string }>, budget: number) => {
    const out: string[] = [];
    let used = 0;
    for (const row of rows) {
      const line = row.content;
      if (used + line.length > budget) break;
      out.push(line);
      used += line.length;
    }
    return out;
  };
  return {
    resident: fill(resident.results, BLOCK_CHARS),
    situational: fill(situational, RECALL_CHARS),
    pending_count: await env.DB.prepare("SELECT count(*) AS n FROM profile_items WHERE status='pending'").first<number>("n"),
  };
}

async function touchProfile(env: Env, ids: string[]) {
  const now = isoNow();
  const stmts = ids.slice(0, 40).map((id) =>
    env.DB.prepare("UPDATE profile_items SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").bind(now, id));
  if (stmts.length) await env.DB.batch(stmts);
  return { touched: stmts.length };
}

async function forgetProfile(env: Env, id: string, reason: string) {
  await ensureSchema(env);
  const row = await env.DB.prepare("SELECT content, normalized_key FROM profile_items WHERE id = ?")
    .bind(id).first<{ content: string; normalized_key: string }>();
  if (!row) return { ok: false, error: "not found" };
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare("UPDATE profile_items SET status='archived', invalid_at=?, expired_at=?, updated_at=? WHERE id=?")
      .bind(now, now, now, id),
    env.DB.prepare("INSERT OR REPLACE INTO profile_tombstones (fingerprint, normalized_key, reason, created_at) VALUES (?,?,?,?)")
      .bind(fingerprint(row.content), row.normalized_key ?? "", reason, now),
  ]);
  return { ok: true, id, tombstoned: true };
}

/**
 * 整理三件事：过期归档、访问衰减、同槽位包含关系合并。
 * 合并是确定性的（规范化后一个内容包含另一个 ⇒ 视为同一件事的不同详略表述），
 * 保留最长最新的那条，其余标 superseded——不依赖 LLM，避免限流时行为漂移。
 */
async function consolidate(env: Env) {
  await ensureSchema(env);
  const now = isoNow();
  const merged: string[] = [];
  const rows = await env.DB.prepare(
    `SELECT id, slot, content, updated_at FROM profile_items
     WHERE status='active' AND invalid_at IS NULL AND slot <> '' ORDER BY slot, LENGTH(content) DESC`,
  ).all<{ id: string; slot: string; content: string; updated_at: string }>();
  const bySlot = new Map<string, Array<{ id: string; content: string }>>();
  for (const r of rows.results) {
    const list = bySlot.get(r.slot) ?? [];
    list.push({ id: r.id, content: r.content });
    bySlot.set(r.slot, list);
  }
  const stmts = [];
  for (const [slot, list] of bySlot) {
    if (list.length < 2) continue;
    const keep = list[0];
    if (!keep) continue;   // noUncheckedIndexedAccess 下 list[0] 是 T | undefined
    for (const other of list.slice(1)) {
      if (normalizeText(keep.content).includes(normalizeText(other.content))) {
        stmts.push(env.DB.prepare(
          `UPDATE profile_items SET status='superseded', superseded_by=?, invalid_at=?, expired_at=?, updated_at=?
           WHERE id = ?`,
        ).bind(keep.id, now, now, now, other.id));
        stmts.push(env.DB.prepare("UPDATE profile_items SET supersedes=? WHERE id=?").bind(other.id, keep.id));
        merged.push(`${slot}:${other.id}`);
      }
    }
  }
  const all = [
    env.DB.prepare("UPDATE profile_items SET status='archived', expired_at=?, updated_at=? WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?").bind(now, now, now),
    env.DB.prepare("UPDATE profile_items SET use_count = CAST(use_count / 2 AS INTEGER) WHERE use_count > 0"),
    env.DB.prepare("UPDATE profile_topics SET promoted_at=? WHERE promoted_at IS NULL AND hits >= ?").bind(now, INTEREST_HITS),
    ...stmts,
  ];
  const r = await env.DB.batch(all);
  return {
    expired_archived: r[0]?.meta?.changes ?? 0,
    decayed: r[1]?.meta?.changes ?? 0,
    topics_promoted: r[2]?.meta?.changes ?? 0,
    merged_away: merged.length,
    merged_detail: merged.slice(0, 10),
  };
}

/** 取代/重复判定的候选：给根侧的 LLM 判断用（同 kind 或同槽位的当前有效条目）。 */
async function candidatesFor(env: Env, slot: string, kind: string) {
  await ensureSchema(env);
  const r = await env.DB.prepare(
    `SELECT id, slot, kind, content, valid_from, origin FROM profile_items
     WHERE status='active' AND invalid_at IS NULL AND (slot = ? OR kind = ?)
     ORDER BY updated_at DESC LIMIT 12`,
  ).bind(slot, kind).all<Record<string, unknown>>();
  return r.results;
}

export async function handleProfile(
  env: Env, path: string, method: string, url: URL, body: Record<string, unknown>,
): Promise<Response | null> {
  await ensureSchema(env);
  const now = isoNow();

  if (path === "/profile/put" && method === "POST") {
    return Response.json(await putProfile(env, body as unknown as ProfileInput));
  }
  if (path === "/profile/recall") {
    return Response.json({ ok: true, ...(await recallProfile(env, url.searchParams.get("q") ?? "")) });
  }
  if (path === "/profile/candidates") {
    return Response.json({
      ok: true,
      items: await candidatesFor(env, url.searchParams.get("slot") ?? "", url.searchParams.get("kind") ?? ""),
    });
  }
  if (path === "/profile/set-slot" && method === "POST") {
    const r = await env.DB.prepare("UPDATE profile_items SET slot=?, updated_at=? WHERE id=?")
      .bind(String(body.slot ?? ""), now, String(body.id ?? "")).run();
    return Response.json({ ok: true, updated: r.meta?.changes ?? 0 });
  }
  if (path === "/profile/noslot") {
    const rows = await env.DB.prepare(
      "SELECT id, kind, content FROM profile_items WHERE status='active' AND slot = '' OR slot IS NULL ORDER BY updated_at DESC LIMIT 200",
    ).all<Record<string, unknown>>();
    return Response.json({ ok: true, items: rows.results });
  }
  if (path === "/profile/slots") {
    return Response.json({ ok: true, slots: await listSlots(env) });
  }
  if (path === "/profile/touch" && method === "POST") {
    const ids = Array.isArray(body.ids) ? (body.ids as unknown[]).map((x) => String(x)) : [];
    return Response.json({ ok: true, ...(await touchProfile(env, ids)) });
  }
  if (path === "/profile/forget" && method === "POST") {
    return Response.json(await forgetProfile(env, String(body.id ?? ""), String(body.reason ?? "user")));
  }
  if (path === "/profile/confirm" && method === "POST") {
    const r = await env.DB.prepare("UPDATE profile_items SET status='active', updated_at=? WHERE id=? AND status='pending'")
      .bind(now, String(body.id ?? "")).run();
    return Response.json({ ok: true, confirmed: r.meta?.changes ?? 0 });
  }
  if (path === "/profile/list") {
    const status = url.searchParams.get("status") ?? "";
    const rows = await env.DB.prepare(
      `SELECT id, slot, kind, content, importance, origin, status, valid_from, invalid_at, expires_at, superseded_by, use_count, updated_at
       FROM profile_items WHERE (? = '' OR status = ?) ORDER BY updated_at DESC LIMIT 100`,
    ).bind(status, status).all<Record<string, unknown>>();
    return Response.json({ ok: true, count: rows.results.length, items: rows.results });
  }
  if (path === "/profile/consolidate" && method === "POST") {
    return Response.json({ ok: true, ...(await consolidate(env)) });
  }
  if (path === "/profile/stats") {
    const byStatus = await env.DB.prepare("SELECT status, count(*) AS n FROM profile_items GROUP BY status")
      .all<{ status: string; n: number }>();
    return Response.json({ ok: true, by_status: byStatus.results, slot_count: SLOTS.length, interest_threshold: INTEREST_HITS });
  }
  return null;
}
