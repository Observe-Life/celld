// 图片/语音转写——金贝贝直连单通道。任何失败直接抛出（该文档任务中止，不产出降级内容）。
import type { Env } from "../env";

const VISION_PROMPT =
  "下面按顺序给出这篇内容里的图片。每张图前面都已经用 [[编号]] 标好了它的编号，" +
  "请你按编号逐张分析，每张图单独一段，段首必须原样写出该编号，不许跳号、不许合并、不许漏图。" +
  "每张图都按下面两部分写：" +
  "文字：把图里出现的文字一字不差地抄下来，保留原有分段和顺序，界面文字、按钮文字、数字、英文都要抄；" +
  "严禁总结、严禁概括、严禁改写、严禁翻译；图上确实没有文字就写「无文字」。" +
  "画面：用一两句话说清这张图画的是什么，包括主体、场景、图表数据或界面结构；" +
  "如果整张图只是纯文字，写「纯文字」即可；只描述真实可见的内容，不要编造、不要评价。" +
  "只输出编号与上述两部分，不要任何开场白、结尾语或额外说明。";

const MODEL = "gemini-3.5-flash-lite"; // 金贝贝实测：19MB体/40图通过；3.1上限仅5MB

interface ChatResponse { choices?: Array<{ message?: { content?: string | Array<{ text?: string }> } }>; }

function pickText(body: string): string {
  const json = JSON.parse(body) as ChatResponse;
  const content = json.choices?.[0]?.message?.content;
  if (typeof content === "string") return content.trim();
  return (content ?? []).map((part) => part.text ?? "").join("").trim();
}

async function callLlm(env: Env, body: unknown, timeoutMs = 180000): Promise<string> {
  const json = JSON.stringify(body);
  if (json.length > 18_000_000) {
    throw new Error(`PAYLOAD_TOO_LARGE: ${(json.length / 1048576).toFixed(1)}MB 超过金贝贝安全上限18MB，请减小图片或拆分`);
  }
  const res = await fetch("https://cn.jbbt.cc/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${env.JBB_KEY}` },
    body: json,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await res.text();
  if (res.status !== 200) throw new Error(`jbb ${res.status}: ${text.slice(0, 200)}`);
  return pickText(text);
}

// 每批 10 张（实测 40 张可行，取平衡点）；任何批次失败即抛出中止
export async function transcribeImages(env: Env, images: Array<{ mime: string; b64: string }>): Promise<string[]> {
  if ((env.SKIP_GEMINI || "").trim() === "1") return images.map(() => "（转写已跳过）");
  const out: string[] = new Array(images.length).fill("");
  const BATCH = 10;
  for (let start = 0; start < images.length; start += BATCH) {
    const batch = images.slice(start, start + BATCH);
    const parts: Array<Record<string, unknown>> = [{ type: "text", text: VISION_PROMPT }];
    batch.forEach((image, index) => {
      parts.push({ type: "text", text: `[[${index + 1}]]` });
      parts.push({ type: "image_url", image_url: { url: `data:${image.mime};base64,${image.b64}` } });
    });
    parts.push({ type: "text", text: "结束" });
    const answer = await callLlm(env, { model: MODEL, temperature: 0, messages: [{ role: "user", content: parts }] });
    for (let index = 0; index < batch.length; index += 1) {
      const hit = answer.split(`[[${index + 1}]]`);
      const value = hit.length > 1 ? hit[1].split("[[")[0].trim() : "";
      if (!value) throw new Error(`VISION_EMPTY: 批次${start / BATCH + 1}第${index + 1}张无转写结果`);
      out[start + index] = value;
    }
  }
  return out;
}

export async function transcribeAudio(env: Env, mime: string, b64: string): Promise<string> {
  if ((env.SKIP_GEMINI || "").trim() === "1") return "（转写已跳过）";
  const format = (mime || "audio/webm").includes("ogg") ? "ogg" : (mime || "").includes("mpeg") ? "mp3" : "webm";
  const body = {
    model: MODEL, temperature: 0,
    messages: [{ role: "user", content: [
      { type: "text", text: "把这条语音转写成文字，只输出文字内容，不要说明。" },
      { type: "input_audio", input_audio: { data: b64, format } },
    ] }],
  };
  return await callLlm(env, body); // 失败即抛出
}
