// 2026-11-03 紧急回滚：typescript.js 在 workerd 加载期引用 Node 全局 __filename，
// 导致 celld 节点崩溃循环（全套件停摆 5 分钟）。已回退为占位 worker。
// 修复方向（二选一，验证后再恢复）：
//   A. 全局 shim（__filename/__dirname/process）——风险：tsc 初始化仍可能触碰 fs
//   B. 采用 @cloudflare/worker-bundler 的 typescript 子路径（CF 官方在 workerd 里跑 TS 的实现）
export default {
  async fetch(): Promise<Response> {
    return Response.json({ ok: false, error: "ts-check 暂不可用（类型检查服务修复中）" }, { status: 503 });
  },
};
