// celld-agent-to-rag 的绑定面。与旧 kb-sync 的差别就是本次改造的要点：
// 没有 QUEUE（重试与状态交给 Workflow）、没有 MM/SCHEDULER（实测零调用的死绑定）、
// 多了 SYNC_FLOW（会话同步的 Workflow 绑定）。
export interface Env {
  STATE: KVNamespace;
  FILES: R2Bucket;
  SYNC_FLOW: Workflow;
  WEKNORA_URL: string;
  WEKNORA_KEY: string;
  JBB_KEY: string;
  GEMINI_KEY: string;
  SHAPI_KEY: string;
  SKIP_GEMINI: string;
  INGEST_TOKEN: string;
  SYNC_ALLOWLIST: string;
  /** 每轮最多创建几个 Workflow 实例；缺省或非正数按 2 处理 */
  SYNC_CONCURRENCY: string;
}
