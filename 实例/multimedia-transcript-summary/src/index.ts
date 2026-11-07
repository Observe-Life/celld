import type { Env } from "./env";
import { PipelineFlow } from "./workflows/pipeline";
import { TranscribeFlow } from "./workflows/transcribe";

export { PipelineFlow, TranscribeFlow };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return Response.json({ ok: true, service: "multimedia-transcript-summary" });
    }
    if (url.pathname === "/run" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { url?: string };
      const target = body.url ?? "https://example.com";
      const instance = await env.PIPELINE.create({ params: { url: target } });
      return Response.json({ ok: true, id: instance.id, target });
    }
    // celld 版新增：按 id 查询工作流实例状态（OC 版没有，运维用）
    if (url.pathname === "/status" && request.method === "POST") {
      const body = (await request.json().catch(() => ({}))) as { id?: string };
      if (!body.id) return Response.json({ ok: false, error: "id required" }, { status: 400 });
      const instance = await env.PIPELINE.get(body.id);
      return Response.json({ ok: true, status: await instance.status() });
    }
    return new Response("not found", { status: 404 });
  },
};
