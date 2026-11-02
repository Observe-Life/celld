export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get("t") || "https://shapi.vip/v1/chat/completions";
    const out = { target, ok: false, status: 0, error: "", body: "" };
    try {
      const res = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body: "{}", signal: AbortSignal.timeout(15000) });
      out.ok = res.ok; out.status = res.status;
      out.body = (await res.text()).slice(0, 200);
    } catch (e) {
      out.error = String(e && e.message || e);
    }
    return Response.json(out);
  },
};
