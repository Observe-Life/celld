// 派活器（KV/R2 版）：比对会话元数据与台账，产出待处理队列消息；下架由 /files DELETE 驱动
import type { Env } from "../env";
import { listMetas, getLedger, isApproved, type SessionMeta } from "../lib/store";
import { findKnowledgeBase } from "../lib/weknora";

export interface WorkItem { uuid: string; }
export interface CollectResult {
  kb: string | null;
  items: WorkItem[];
  pendingApproval: SessionMeta[];
}

export async function collectWork(env: Env, limit?: number): Promise<CollectResult> {
  const report: CollectResult = { kb: null, items: [], pendingApproval: [] };
  const kb = await findKnowledgeBase(env);
  if (!kb) return report;
  report.kb = kb.id;

  const metas = await listMetas(env.STATE);
  for (const meta of metas) {
    if (!(await isApproved(env.STATE, meta.uuid))) continue; // 未审批（含已下架）永不自愈复活
    const ledger = await getLedger(env.STATE, meta.uuid);
    if (!ledger || ledger.updated_at !== meta.updated_at) {
      report.items.push({ uuid: meta.uuid });
    }
  }
  report.items.sort((a, b) => (a.uuid < b.uuid ? 1 : -1));
  if (limit != null) report.items = report.items.slice(0, limit);
  return report;
}

export async function listPendingApproval(env: Env): Promise<SessionMeta[]> {
  const out: SessionMeta[] = [];
  for (const meta of await listMetas(env.STATE)) {
    const ledger = await getLedger(env.STATE, meta.uuid);
    if (!ledger) out.push(meta);
  }
  return out;
}
