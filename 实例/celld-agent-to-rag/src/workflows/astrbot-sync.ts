// AstrBot 拉取流程：单实例串行全部页（实例号固定 astrbot-pull）。
// 6 页并发曾把共享堆顶过压强水位（latch 吸合后存储路由 CapacityExhausted），
// therefore 只开一个实例逐步跑——慢，但每步独立缓存、绝不打爆。
// 只做搬运（列表→增量→导出→落 R2/KV→自动审批→派活）；md/转写/推 rag-ferrite
// 仍走既有 SessionSyncFlow 路径（下一轮对账发现新 meta 后建实例）。
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../env";
import { importRef, scanPage } from "../lib/astrbot";

export interface PullParams {
  maxPages?: number;
}

export class AstrBotPullFlow extends WorkflowEntrypoint<Env, PullParams> {
  async run(event: WorkflowEvent<PullParams>, step: WorkflowStep) {
    const maxPages = Math.min(Math.max(Math.floor(event.payload?.maxPages ?? 6), 1), 6);
    let scanned = 0;
    let imported = 0;
    let dispatched = 0;
    const failures: string[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const report = await step.do(
        `page-${page}`,
        { retries: { limit: 1, delay: "3 seconds" }, timeout: "15 minutes" },
        async () => {
          interface PageScan {
            refs: Array<{ user_id: string; cid: string; updated_at: number }>;
            totalPages: number;
          }
          const scan: PageScan = await scanPage(this.env, page, 50);
          let imported = 0;
          let failed = 0;
          for (const ref of scan.refs) {
            const ok = await importRef(this.env, ref).catch((error) => {
              failures.push(`${ref.cid.slice(0, 8)}: ${String(error).slice(0, 120)}`);
              return false;
            });
            if (ok) imported += 1; else failed += 1;
          }
          return { toDispatch: scan.refs, scanned: scan.refs.length, imported, failed };
        },
      );
      scanned += report.scanned;
      imported += report.imported;
      report.toDispatch = report.toDispatch ?? [];
      // 派活：与 index.ts startSessions 同号语义（uuid-版本），平台去重。
      const batch = report.toDispatch.slice(0, this.concurrency()).map((ref) => ({
        id: `${ref.cid}-${ref.updated_at || 0}`.slice(0, 100),
        params: { uuid: ref.cid, wf: `pull-${ref.updated_at || 0}`.slice(0, 100) },
        retention: { successRetention: 0, errorRetention: 3_600_000 },
      }));
      if (batch.length) {
        const created = (await this.env.SYNC_FLOW.createBatch(batch as never)) as unknown as Array<{ id: string }>;
        dispatched += Array.isArray(created) ? created.length : 0;
      }
    }
    return { scanned, imported, dispatched, failures: failures.slice(0, 5) };
  }

  private concurrency(): number {
    const n = Number.parseInt(this.env.SYNC_CONCURRENCY ?? "", 10);
    return Number.isFinite(n) && n > 0 ? n : 2;
  }
}
