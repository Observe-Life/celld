// 知识召回闸门：本容器的根（对外唯一入口 + 持有全部 cron）。
// 注意：这里**不声明 D1 绑定**——celld 文档明确「一个数据库只有一个 writer」，
// 时间轴与画像的写权全在 knowledge-timeline-impression，闸门只读、只转写请求。
export interface Env {
  TIMELINE: { fetch(input: Request): Promise<Response> };
  WEKNORA_URL: string;
  WEKNORA_KEY: string;
  RECALL_KB_IDS: string;
  /** 经验通道是否启用向量段（weknora 侧向量查询当前 60s 不返回，默认 0=只用关键词） */
  RECALL_CORPUS_VECTOR: string;
}
