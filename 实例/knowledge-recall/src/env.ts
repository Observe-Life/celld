// 知识召回闸门：本容器的根（对外唯一入口 + 持有全部 cron）。
// 注意：这里**不声明 D1 绑定**——celld 文档明确「一个数据库只有一个 writer」，
// 时间轴与画像的写权全在 knowledge-timeline-impression，闸门只读、只转写请求。
export interface Env {
  TIMELINE: { fetch(input: Request): Promise<Response> };
  RAGF_URL: string;
  RAGF_KEY: string;
  GEMINI_BASE: string;
  GEMINI_MODEL: string;
  GEMINI_KEY: string;
}
