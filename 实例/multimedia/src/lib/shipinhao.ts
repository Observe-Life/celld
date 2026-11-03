export function extractSphUrl(raw: string): string {
  const text = (raw || "").trim();
  const match = text.match(/https?:\/\/(?:weixin|channels)\.qq\.com\/(?:sph|finder-preview\/pages\/sph)[^\s]*/i);
  let url = match ? match[0] : text;
  url = url.replace(/\?.*$/, "");
  return url.replace("channels.weixin.qq.com/finder-preview/pages/sph", "weixin.qq.com/sph");
}

export interface SphDecrypt {
  url: string;
  key: string;
  title: string;
  bytes: number;
  err: string;
}

export function parseSphDecrypt(body: string): SphDecrypt {
  const out: SphDecrypt = { url: "", key: "", title: "", bytes: 0, err: "" };
  try {
    const data = JSON.parse(body) as Record<string, unknown>;
    if (data.ok) {
      out.url = String(data.url ?? "");
      out.key = String(data.key ?? "");
      out.title = String(data.title ?? "");
      out.bytes = Number(data.bytes ?? 0);
      if (!out.key) {
        if (out.url.includes("/get/")) out.key = out.url.split("/get/")[1];
        else if (out.url.includes(".r2.dev/")) out.key = out.url.split(".r2.dev/")[1];
      }
      if (!out.url) out.err = "返回成功但没有网址";
    } else {
      out.err = String(data.error ?? "未知错误");
      if (data.attempts) out.err += `（取地址尝试 ${data.attempts} 次）`;
    }
  } catch (error) {
    out.err = String(error).slice(0, 200);
  }
  return out;
}
