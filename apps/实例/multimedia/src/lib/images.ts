const VISION_PROMPT =
  "下面按顺序给出这篇内容里的图片。每张图前面都已经用 [[编号]] 标好了它的编号，" +
  "请你按编号逐张分析，每张图单独一段，段首必须原样写出该编号，不许跳号、不许合并、不许漏图。" +
  "每张图都按下面两部分写：" +
  "文字：把图里出现的文字一字不差地抄下来，保留原有分段和顺序，界面文字、按钮文字、数字、英文都要抄；" +
  "严禁总结、严禁概括、严禁改写、严禁翻译；图上确实没有文字就写「无文字」。" +
  "画面：用一两句话说清这张图画的是什么，包括主体、场景、图表数据或界面结构；" +
  "如果整张图只是纯文字，写「纯文字」即可；只描述真实可见的内容，不要编造、不要评价。" +
  "只输出编号与上述两部分，不要任何开场白、结尾语或额外说明。";

function supported(url: string): boolean {
  const value = url.toLowerCase();
  if (value.includes("wx_fmt=gif")) return false;
  if (value.split("?")[0].endsWith(".gif")) return false;
  return true;
}

export function extractImages(text: string): string[] {
  const images: string[] = [];
  for (const segment of (text || "").split("![")) {
    const open = segment.indexOf("(");
    const close = segment.indexOf(")");
    if (open >= 0 && close > open) {
      const url = segment.slice(open + 1, close).trim();
      if (url.startsWith("http")) images.push(url);
    }
  }
  return images;
}

export function buildVisionRequest(text: string): {
  body: string;
  total: number;
  sent: number;
  skipped: number;
} {
  const images = extractImages(text);
  const usable = images
    .map((url, index) => ({ no: index + 1, url }))
    .filter((item) => supported(item.url))
    .slice(0, 12);
  const content: Array<Record<string, unknown>> = [{ type: "text", text: VISION_PROMPT }];
  for (const item of usable) {
    content.push({ type: "text", text: `[[${item.no}]]` });
    content.push({ type: "image_url", image_url: { url: item.url } });
  }
  content.push({ type: "text", text: "结束" });
  const body = {
    model: "gemini-3.1-flash-lite",
    temperature: 0,
    messages: [{ role: "user", content }],
  };
  return {
    body: JSON.stringify(body),
    total: images.length,
    sent: usable.length,
    skipped: images.length - usable.length,
  };
}

export function applyImageText(text: string, answer: string): string {
  const segments = text.split("![");
  let out = segments[0] ?? "";
  for (let index = 1; index < segments.length; index += 1) {
    const segment = segments[index];
    const open = segment.indexOf("(");
    const close = segment.indexOf(")");
    const url = open >= 0 && close > open ? segment.slice(open + 1, close).trim() : "";
    const hit = answer.split(`[[${index}]]`);
    let value = "";
    if (hit.length > 1) {
      value = hit[1]
        .split("[[")[0]
        .replace(/\\n/g, "\n")
        .split('"},"')[0]
        .trim()
        .replace(/"$/, "")
        .trim();
    }
    const isGif = url.toLowerCase().includes("gif");
    const fallback = isGif ? "（gif图未读出）" : "（未读出内容）";
    const suffix = close >= 0 ? segment.slice(close + 1) : "";
    out += `【图${index}：${value || fallback}】${suffix}`;
  }
  return out;
}
