export interface Env {
  STATE: KVNamespace;
  FILES: R2Bucket;
  QUEUE: Queue;
  WEKNORA_URL: string;
  WEKNORA_KEY: string;
  JBB_KEY: string;
  GEMINI_KEY: string;
  SHAPI_KEY: string;
  SKIP_GEMINI: string;
  INGEST_TOKEN: string;
  SYNC_ALLOWLIST: string;
  MM: { fetch(input: Request): Promise<Response> };
  SCHEDULER: { fetch(input: Request): Promise<Response> };
}
