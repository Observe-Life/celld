// 对账：找出「台账缺失或版本落后」的已审批会话，交给 Workflow 实例去跑。
// 与旧版的唯一区别：items 带上 updated_at，因为实例号需要版本（同会话更新要能新建实例）。
import type { Env } from "../env";
import { getLedger, isApproved, listMetas, type SessionMeta } from "../lib/store";

export interface WorkItem {
  uuid: string;
  updated_at: string;
}

export interface CollectResult {
  items: WorkItem[];
}

export async function collectWork(env: Env, limit?: number): Promise<CollectResult> {
  const report: CollectResult = { items: [] };
  for (const meta of await listMetas(env.STATE)) {
    if (!(await isApproved(env.STATE, meta.uuid))) continue; // 未审批（含已下架）永不自愈复活
    const ledger = await getLedger(env.STATE, meta.uuid);
    if (!ledger || ledger.updated_at !== meta.updated_at) {
      report.items.push({ uuid: meta.uuid, updated_at: meta.updated_at });
    }
  }
  report.items.sort((a, b) => (a.uuid < b.uuid ? 1 : -1));
  if (limit != null) report.items = report.items.slice(0, limit);
  return report;
}

export async function listPendingApproval(env: Env): Promise<SessionMeta[]> {
  const pending: SessionMeta[] = [];
  for (const meta of await listMetas(env.STATE)) {
    if (!(await getLedger(env.STATE, meta.uuid))) pending.push(meta);
  }
  return pending;
}

/** 实例号 = uuid + 版本。版本取自 updated_at 的非字母数字清洗，保证：
 *  同一会话同一版本重复触发 → 同号 → 被 createBatch 静默去重；
 *  会话有更新 → 新版本 → 新实例。长度受平台限制 ≤100 字符。 */
export function instanceId(uuid: string, updatedAt: string): string {
  const version = updatedAt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 24) || "0";
  return `${uuid}-${version}`.slice(0, 100);
}
