// 画像知识（以个人画像、偏好为中心）的数据层。
//
// 机制照搬 WeKnora memory 已验证的设计，但实现在我们自己手里（用户决策 Q-f）：
//   · 五类 kind：profile/preference/fact/task/interest
//   · pending 不注入：自动推断出来的条目必须 confirm 才生效——默默断言一个错误猜测
//     会让记忆功能永久失去信任（WeKnora 源码里的原话理由）
//   · 取代而非删除：同 normalized_key 的新值把旧值标 superseded，可解释「什么时候变的」
//   · 遗忘墓碑：删掉的条目记下指纹，后续提取命中就跳过，不会被写回来
//   · 类型化 TTL + 访问强化：命中记 use_count；整理时 use_count*=0.5，防旧热点永久霸占
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
CREATE INDEX IF NOT EXISTS idx_pf_status ON profile_items(status, kind);
CREATE INDEX IF NOT EXISTS idx_pf_key ON profile_items(normalized_key);
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

/** 类型化 TTL（天数）：与 WeKnora 的量级一致，importance 与 use_count 会放大它。 */
const TTL_DAYS: Record<string, number> = {
  task: 2,
  event: 7,
  preference: 60,
  relation: 90,
  fact: 180,
  profile: 3650,
  interest: 3650,
};

/** 常驻块预算（字符）：profile/preference/interest 每轮都带，必须小。 */
const BLOCK_CHARS = 900;
/** 按题召回预算：fact/task 只在命中当前问题时带。 */
const RECALL_CHARS = 600;
const RECALL_MAX_ITEMS = 5;
/** interest 晋升阈值：主题在多少个会话里出现过才算长期关注。 */
const INTEREST_HITS = 3;

export interface ProfileInput {
  kind: string;
  content: string;
  topic?: string;
  normalized_key?: string;
  importance?: number;
  origin?: string;
  source_ref?: string;
  valid_from?: string;
  invalid_at?: string;
  expires_in_days?: number;
}

function isoNow(): string { return new Date().toISOString(); }

function normKey(kind: string, content: string, explicit?: string): string {
  if (explicit) return explicit;
  // 主题化去重键：kind + 内容的稳定前缀，避免同一件事被记成多条
  const base = content.replace(/\s+/g, "").slice(0, 24);
  return `${kind}:${base}`;
}

function fingerprint(content: string): string {
  let h = 2166136261;
  for (let i = 0; i < content.length; i += 1) {
    h ^= content.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
}

function expiryFor(kind: string, importance: number, useCount: number, override?: number): string {
  const days = override ?? TTL_DAYS[kind] ?? 30;
  const boost = 1 + Math.max(0, importance - 3) * 0.5 + useCount * 0.1;
  return new Date(Date.now() + days * boost * 86_400_000).toISOString();
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.exec(SCHEMA);
}

/** 写入画像条目。explicit/manual 直接 active；extracted 一律 pending（不注入）。 */
async function putProfile(env: Env, input: ProfileInput) {
  const content = input.content.replace(/\s+/g, " ").trim().slice(0, 400);
  if (!content) return { ok: false, error: "empty content" };

  const fp = fingerprint(content);
  const tomb = await env.DB
    .prepare("SELECT fingerprint FROM profile_tombstones WHERE fingerprint = ?")
    .bind(fp).first<string>();
  if (tomb != null) return { ok: true, skipped: "tombstoned", fingerprint: fp };

  const origin = input.origin ?? "explicit";
  const status = origin === "extracted" ? "pending" : "active";
  const importance = Math.min(Math.max(input.importance ?? 3, 1), 5);
  const key = normKey(input.kind, content, input.normalized_key);
  const id = `${key}:${Date.now().toString(36)}`;
  const now = isoNow();

  const stmts = [
    // 17 列全部用占位符：混写 NULL/0 字面量会让占位符数与 bind 数错位（D1 直接报
    // Wrong number of parameter bindings）。
    env.DB.prepare(
      `INSERT INTO profile_items
       (id, kind, content, topic, normalized_key, importance, origin, status,
        valid_from, invalid_at, expires_at, superseded_by, source_ref, last_used_at,
        use_count, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).bind(
      id, input.kind, content, input.topic ?? "", key, importance, origin, status,
      input.valid_from ?? now, input.invalid_at ?? null,
      expiryFor(input.kind, importance, 0, input.expires_in_days),
      null, input.source_ref ?? null, null,
      0, now, now,
    ),
  ];

  // 同键取代：旧值标 superseded 而不是删掉（保留「什么时候变了」的可解释性）
  if (status === "active") {
    stmts.push(
      env.DB.prepare(
        "UPDATE profile_items SET status='superseded', superseded_by=?, updated_at=? WHERE normalized_key=? AND status='active' AND id <> ?",
      ).bind(id, now, key, id),
    );
  }
  await env.DB.batch(stmts);
  return { ok: true, id, status, kind: input.kind, importance };
}

/** 召回：常驻块（profile/preference/interest）+ 按题匹配（fact/task）。 */
async function recallProfile(env: Env, q: string) {
  const now = isoNow();
  const resident = await env.DB
    .prepare(
      `SELECT id, kind, content, importance FROM profile_items
       WHERE status='active' AND kind IN ('profile','preference','interest')
         AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY importance DESC, updated_at DESC LIMIT 20`,
    ).bind(now).all<{ id: string; kind: string; content: string; importance: number }>();

  let situational: Array<{ id: string; kind: string; content: string; importance: number }> = [];
  const words = q.trim().split(/\s+/).filter((w) => w.length >= 2).slice(0, 4);
  if (words.length) {
    const or = words.map(() => "(content LIKE ? OR topic LIKE ?)").join(" OR ");
    const args: string[] = [];
    for (const w of words) args.push(`%${w}%`, `%${w}%`);
    const r = await env.DB
      .prepare(
        `SELECT id, kind, content, importance FROM profile_items
         WHERE status='active' AND kind IN ('fact','task')
           AND (expires_at IS NULL OR expires_at > ?) AND (${or})
         ORDER BY importance DESC, updated_at DESC LIMIT ${RECALL_MAX_ITEMS}`,
      ).bind(now, ...(args as never[])).all<{ id: string; kind: string; content: string; importance: number }>();
    situational = r.results;
  }

  const fill = (rows: Array<{ kind: string; content: string }>, budget: number) => {
    const out: string[] = [];
    let used = 0;
    for (const row of rows) {
      const line = `[${row.kind}] ${row.content}`;
      if (used + line.length > budget) break;
      out.push(line);
      used += line.length;
    }
    return out;
  };

  return {
    resident: fill(resident.results, BLOCK_CHARS),
    situational: fill(situational, RECALL_CHARS),
    ids: [...resident.results.map((r) => r.id), ...situational.map((r) => r.id)],
    pending_count: await env.DB.prepare("SELECT count(*) AS n FROM profile_items WHERE status='pending'").first<number>("n"),
  };
}

/** 命中计数：召回侧不直接写库（D1 单写者），攒批后调这里。 */
async function touchProfile(env: Env, ids: string[]) {
  const now = isoNow();
  const stmts = ids.slice(0, 40).map((id) =>
    env.DB.prepare("UPDATE profile_items SET use_count = use_count + 1, last_used_at = ? WHERE id = ?").bind(now, id));
  if (stmts.length) await env.DB.batch(stmts);
  return { touched: stmts.length };
}

/** 删除/拒绝：写墓碑，防止后续提取把同一条写回来。 */
async function forgetProfile(env: Env, id: string, reason: string) {
  const row = await env.DB.prepare("SELECT content, normalized_key FROM profile_items WHERE id = ?")
    .bind(id).first<{ content: string; normalized_key: string }>();
  if (!row) return { ok: false, error: "not found" };
  const now = isoNow();
  await env.DB.batch([
    env.DB.prepare("UPDATE profile_items SET status='archived', updated_at=? WHERE id=?").bind(now, now),
    env.DB.prepare("INSERT OR REPLACE INTO profile_tombstones (fingerprint, normalized_key, reason, created_at) VALUES (?,?,?,?)")
      .bind(fingerprint(row.content), row.normalized_key ?? "", reason, now),
  ]);
  return { ok: true, id, tombstoned: true };
}

/** 整理：过期归档、访问衰减、主题晋升 interest。 */
async function consolidate(env: Env) {
  const now = isoNow();
  const r = await env.DB.batch([
    env.DB.prepare("UPDATE profile_items SET status='archived', updated_at=? WHERE status='active' AND expires_at IS NOT NULL AND expires_at <= ?").bind(now, now),
    env.DB.prepare("UPDATE profile_items SET use_count = CAST(use_count / 2 AS INTEGER) WHERE use_count > 0"),
    env.DB.prepare("UPDATE profile_topics SET promoted_at=? WHERE promoted_at IS NULL AND hits >= ?").bind(now, INTEREST_HITS),
  ]);
  return { expired_archived: r[0]?.meta?.changes ?? 0, decayed: r[1]?.meta?.changes ?? 0, topics_promoted: r[2]?.meta?.changes ?? 0 };
}

export async function handleProfile(
  env: Env,
  path: string,
  method: string,
  url: URL,
  body: Record<string, unknown>,
): Promise<Response | null> {
  await ensureSchema(env);
  const now = isoNow();

  if (path === "/profile/put" && method === "POST") {
    return Response.json(await putProfile(env, body as unknown as ProfileInput));
  }
  if (path === "/profile/recall") {
    return Response.json({ ok: true, ...(await recallProfile(env, url.searchParams.get("q") ?? "")) });
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
      `SELECT id, kind, content, importance, origin, status, expires_at, use_count, updated_at
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
    return Response.json({ ok: true, by_status: byStatus.results, interest_threshold: INTEREST_HITS });
  }
  return null;
}
