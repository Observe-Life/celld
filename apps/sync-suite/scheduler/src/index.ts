// 独立调度器：全平台所有 cron 表达式集中在此，到点按表分发，worker 不感知时间。
// 加一个周期任务 = 在 SCHEDULES 加一行 + 在 crons 数组加一个表达式，worker 代码零改动。
interface Route { service: "KBSYNC" | "MM"; path: string; method?: string }

// 表达式 → 目标。支持任意标准 cron（每天7点=0 7 * * *，每5秒用队列/事件另议，cron 最小粒度为分钟）
const SCHEDULES: Record<string, Route> = {
  "37 * * * *": { service: "KBSYNC", path: "/run", method: "POST" }, // 会话同步：每小时
  // "0 7 * * *":  { service: "MM", path: "/daily-job" },            // 示例：每天7点的其它任务
};

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "scheduler", schedules: Object.keys(SCHEDULES) });
    }
    // 前门转发：/kb/* 与 /mm/* 直达对应 worker（scheduler 是常驻根/入口）
    if (url.pathname.startsWith("/kb") || url.pathname.startsWith("/mm")) {
      const isKb = url.pathname.startsWith("/kb");
      const target = isKb ? env.KBSYNC : env.MM;
      const inner = new Request(request.url.replace(isKb ? "/kb" : "/mm", ""), {
        method: request.method,
        headers: request.headers,
        body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      });
      return await target.fetch(inner);
    }
    // 手动触发一条表达式（运维/测试用）：POST /fire {"cron":"37 * * * *"}
    if (url.pathname === "/fire" && request.method === "POST") {
      const body = await request.json().catch(() => ({})) as { cron?: string };
      const route = body.cron ? SCHEDULES[body.cron] : undefined;
      if (!route) return Response.json({ ok: false, error: "unknown cron" }, { status: 400 });
      return await dispatch(env, route);
    }
    return new Response("not found", { status: 404 });
  },

  async scheduled(controller: any, env: any): Promise<void> {
    const route = SCHEDULES[controller.cron];
    if (!route) { console.warn("[scheduler] no route for", controller.cron); return; }
    const res = await dispatch(env, route);
    console.log("[scheduler] fired", controller.cron, "->", route.service, route.path, res.status);
  },
};

async function dispatch(env: any, route: Route): Promise<Response> {
  const target = env[route.service];
  const req = new Request("http://internal" + route.path, {
    method: route.method ?? "GET",
  });
  return await target.fetch(req);
}
