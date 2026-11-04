// 时间轴与画像的数据 worker。D1 的唯一写者（celld 文档：一个数据库只有一个 writer）。
export interface Env {
  DB: D1Database;
}
