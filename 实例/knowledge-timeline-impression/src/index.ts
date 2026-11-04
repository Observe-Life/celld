// 时间轴与画像的数据 worker（cohosted，不对外、不带 cron）。
// D1 的唯一写者——celld 文档明确「一个数据库只有一个 writer」，所以召回侧要更新
// use_count 也不能直接写库，必须攒批后交给这里落。
//
// 中文词法召回的实测结论（P0 冒烟）：
//   FTS5 默认分词器 unicode61 不切中文，MATCH 中文短词会**静默返回空**；
//   tokenize='trigram' 可用但要求 ≥3 字符；<3 字必须回退 LIKE。
// 所以这里的词法通道是「trigram 优先 + 短词 LIKE 回退」，不能只依赖 FTS5。
import type { Env } from "./env";
import { handleProfile } from "./profile";

/** 迁移只进不退：新列一律用 ADD COLUMN + 默认值，禁止 DROP/改名。 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS timeline_entries (
  id              TEXT PRIMARY KEY,
  knowledge_id    TEXT NOT NULL,
  kb_id           TEXT NOT NULL DEFAULT '',
  seq             INTEGER NOT NULL DEFAULT 0,
  source_kind     TEXT NOT NULL DEFAULT 'conversation',
  channel         TEXT NOT NULL DEFAULT '',
  subject         TEXT NOT NULL DEFAULT '',
  event_time      TEXT NOT NULL,
  note_time       TEXT,
  ingested_at     TEXT NOT NULL,
  snippet         TEXT NOT NULL,
  title           TEXT NOT NULL DEFAULT '',
  time_tags       TEXT NOT NULL DEFAULT '',
  conversation_id TEXT NOT NULL DEFAULT '',
  deleted         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tl_event ON timeline_entries(event_time DESC);
CREATE INDEX IF NOT EXISTS idx_tl_kind_time ON timeline_entries(source_kind, event_time DESC);
CREATE INDEX IF NOT EXISTS idx_tl_knowledge ON timeline_entries(knowledge_id);
CREATE INDEX IF NOT EXISTS idx_tl_subject ON timeline_entries(subject, event_time DESC);
CREATE VIRTUAL TABLE IF NOT EXISTS timeline_fts USING fts5(entry_id, snippet, tokenize='trigram');
`;

const DAY = 86_400_000;
/** 单批语句数上限：D1 每条语句最多 100 个绑定参数，这里 11 列 ⇒ 每批留足余量。 */
const BATCH_STATEMENTS = 40;

export interface TimelineInput {
  knowledge_id: string;
  kb_id?: string;
  seq?: number;
  source_kind?: string;
  channel?: string;
  subject?: string;
  event_time: string;
  note_time?: string;
  snippet: string;
  title?: string;
  conversation_id?: string;
}

function timeTags(eventTime: string): string {
  const d = eventTime.slice(0, 10);
  return [d.slice(0, 4), d.slice(0, 7), d].join(" ");
}

async function ensureSchema(env: Env): Promise<void> {
  await env.DB.exec(SCHEMA);
}

/** 写入一批时间轴条目：timeline_entries + timeline_fts 同批提交（一次 dispatch）。 */
async function putTimeline(env: Env, items: TimelineInput[]): Promise<{ written: number }> {
  if (!items.length) return { written: 0 };
  const nowIso = new Date().toISOString();
  const stmts = [];
  for (const it of items) {
    const seq = it.seq ?? 0;
    const id = `${it.knowledge_id}:${seq}`;
    const snippet = it.snippet.slice(0, 500);
    stmts.push(
      env.DB.prepare(
        `INSERT OR REPLACE INTO timeline_entries
         (id, knowledge_id, kb_id, seq, source_kind, channel, subject, event_time, note_time,
          ingested_at, snippet, title, time_tags, conversation_id, deleted)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0)`,
      ).bind(
        id,
        it.knowledge_id,
        it.kb_id ?? "",
        seq,
        it.source_kind ?? "conversation",
        it.channel ?? "",
        it.subject ?? "",
        it.event_time,
        it.note_time ?? null,
        nowIso,
        snippet,
        it.title ?? "",
        timeTags(it.event_time),
        it.conversation_id ?? "",
      ),
    );
    stmts.push(
      env.DB.prepare("INSERT OR REPLACE INTO timeline_fts (rowid, entry_id, snippet) VALUES ((SELECT rowid FROM timeline_entries WHERE id = ?), ?, ?)").bind(id, id, snippet),
    );
  }
  let written = 0;
  for (let i = 0; i < stmts.length; i += BATCH_STATEMENTS) {
    const results = await env.DB.batch(stmts.slice(i, i + BATCH_STATEMENTS));
    for (const r of results) written += r.meta?.changes ?? 0;
  }
  return { written };
}

/** 时间窗 + 词法召回。词法：≥3 字走 trigram，<3 字回退 LIKE（P0 实测的坑）。 */
async function queryTimeline(
  env: Env,
  q: string,
  since?: string,
  until?: string,
  limit = 20,
  sourceKind?: string,
  subject?: string,
) {
  const cap = Math.min(Math.max(limit, 1), 100);
  const words = q.trim().split(/\s+/).filter(Boolean);
  const likeWord = words[0] ?? "";
  const useTrigram = likeWord.length >= 3;

  const where: string[] = ["t.deleted = 0"];
  const args: unknown[] = [];
  if (since) { where.push("t.event_time >= ?"); args.push(since); }
  if (until) { where.push("t.event_time <= ?"); args.push(until); }
  if (sourceKind) { where.push("t.source_kind = ?"); args.push(sourceKind); }
  if (subject) { where.push("t.subject = ?"); args.push(subject); }

  let joinFts = false;
  if (useTrigram) {
    where.push("t.id = f.entry_id");
    joinFts = true;
  } else if (likeWord) {
    where.push("t.snippet LIKE ?");
    args.push(`%${likeWord}%`);
  }

  const sql =
    `SELECT t.id, t.knowledge_id, t.seq, t.event_time, t.snippet, t.title, t.source_kind, t.channel, t.conversation_id
     FROM timeline_entries t${joinFts ? ", timeline_fts f" : ""}
     WHERE ${where.join(" AND ")}
     ORDER BY t.event_time DESC LIMIT ?`;
  const rows = await env.DB
    .prepare(sql)
    .bind(...(args as never[]), cap)
    .all<Record<string, string | number | null>>();
  return { mode: useTrigram ? "trigram" : likeWord ? "like" : "time-only", count: rows.results.length, hits: rows.results };
}

/** 对账：时间轴覆盖了多少素材、有多少孤儿（素材已删但时间轴还在）。 */
async function reconcile(env: Env) {
  const total = await env.DB.prepare("SELECT count(*) AS n FROM timeline_entries").first<number>("n");
  const docs = await env.DB.prepare("SELECT count(DISTINCT knowledge_id) AS n FROM timeline_entries WHERE deleted = 0").first<number>("n");
  const softDeleted = await env.DB.prepare("SELECT count(*) AS n FROM timeline_entries WHERE deleted = 1").first<number>("n");
  const oldest = await env.DB.prepare("SELECT min(event_time) AS v FROM timeline_entries WHERE deleted = 0").first<string>("v");
  const newest = await env.DB.prepare("SELECT max(event_time) AS v FROM timeline_entries WHERE deleted = 0").first<string>("v");
  return { entries: total, documents: docs, soft_deleted: softDeleted, oldest, newest };
}

/** 素材删除时同步软删（不留孤儿）。 */
async function forgetKnowledge(env: Env, knowledgeId: string) {
  const r = await env.DB.prepare("UPDATE timeline_entries SET deleted = 1 WHERE knowledge_id = ?").bind(knowledgeId).run();
  await env.DB.prepare("DELETE FROM timeline_fts WHERE entry_id IN (SELECT id FROM timeline_entries WHERE knowledge_id = ?)").bind(knowledgeId).run();
  return { knowledge_id: knowledgeId, marked: r.meta?.changes ?? 0 };
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  return (await request.json().catch(() => ({}))) as Record<string, unknown>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "knowledge-timeline-impression", role: "data-worker" });
    }
    // 画像路由自成一体（profile_* 表由 profile.ts 建），先分流再走时间轴逻辑
    if (url.pathname.startsWith("/profile/")) {
      const body = (request.method === "POST"
        ? await request.json().catch(() => ({}))
        : {}) as Record<string, unknown>;
      const handled = await handleProfile(env, url.pathname, request.method, url, body);
      return handled ?? Response.json({ ok: false, error: "unknown profile route" }, { status: 404 });
    }

    try {
      await ensureSchema(env);

      if (url.pathname === "/timeline/put" && request.method === "POST") {
        const body = await readJson(request);
        const items = (body.items ?? []) as TimelineInput[];
        return Response.json({ ok: true, ...(await putTimeline(env, items)) });
      }
      if (url.pathname === "/timeline/query") {
        const q = url.searchParams.get("q") ?? "";
        const res = await queryTimeline(
          env,
          q,
          url.searchParams.get("since") ?? undefined,
          url.searchParams.get("until") ?? undefined,
          Number.parseInt(url.searchParams.get("limit") ?? "20", 10) || 20,
          url.searchParams.get("source_kind") ?? undefined,
          url.searchParams.get("subject") ?? undefined,
        );
        return Response.json({ ok: true, ...res });
      }
      if (url.pathname === "/timeline/reconcile") {
        return Response.json({ ok: true, ...(await reconcile(env)) });
      }
      if (url.pathname === "/timeline/forget" && request.method === "POST") {
        const body = await readJson(request);
        return Response.json({ ok: true, ...(await forgetKnowledge(env, String(body.knowledge_id ?? ""))) });
      }
      // 回填自检：一次 batch 能塞多少语句（验证 D1 绑定参数上限的实际口径）
      if (url.pathname === "/selftest/batch") {
        const n = Number.parseInt(url.searchParams.get("n") ?? "40", 10) || 40;
        const items: TimelineInput[] = [];
        for (let i = 0; i < n; i += 1) {
          items.push({
            knowledge_id: "selftest",
            seq: i,
            event_time: new Date(Date.now() - i * DAY).toISOString(),
            snippet: `自检条目 ${i}：中文词法召回测试`,
          });
        }
        const t0 = Date.now();
        const r = await putTimeline(env, items);
        return Response.json({ ok: true, requested: n, ...r, ms: Date.now() - t0 });
      }
    } catch (e) {
      return Response.json({ ok: false, error: String(e).slice(0, 300) }, { status: 500 });
    }
    return new Response("not found", { status: 404 });
  },
};
