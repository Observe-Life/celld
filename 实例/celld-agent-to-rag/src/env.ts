// celld-agent-to-rag 的绑定面。与旧 kb-sync 的差别就是本次改造的要点：
// 没有 QUEUE（重试与状态交给 Workflow）、没有 MM/SCHEDULER（实测零调用的死绑定）、
// 多了 SYNC_FLOW（会话同步的 Workflow 绑定）。
export interface Env {
  STATE: KVNamespace;
  FILES: R2Bucket;
  /** 会话 md 镜像目录（disk 绑定，workerd DiskDirectory 语义） */
  MIRROR: {
    get(path: string): Promise<string | Array<{ name: string; type: string }>>;
    put(path: string, data: string): Promise<void>;
    list(path?: string): Promise<Array<{ name: string; type: string }>>;
    delete(path: string): Promise<void>;
  };
  SYNC_FLOW: Workflow;
  RAGF_URL: string;
  RAGF_KEY: string;
  JBB_KEY: string;
  GEMINI_KEY: string;
  SHAPI_KEY: string;
  SKIP_GEMINI: string;
  INGEST_TOKEN: string;
  SYNC_ALLOWLIST: string;
  /** 每轮最多创建几个 Workflow 实例；缺省或非正数按 2 处理 */
  SYNC_CONCURRENCY: string;
  /** AstrBot OpenAPI 拉取通道（v4.18+ API Key，仅 data scope）与基址 */
  ASTRBOT_API_KEY: string;
  ASTRBOT_URL: string;
}
