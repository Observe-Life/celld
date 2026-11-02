// 会话原始数据 → md。数据来自插件推送的 raw 载荷（消息+附件base64），不再依赖外部通道。
import type { Env } from "../env";
import { transcribeImages } from "./transcribe";

export interface RawPart {
  type: string;
  text?: string;
  filename?: string;
  attachment_id?: string;
  mime?: string;
  b64?: string;
  image_url?: { url?: string };
}
export interface RawMessage { ts?: string; role: string; parts: RawPart[]; }
export interface RawSession {
  uuid: string;
  conversation_id: string;
  title: string;
  platform: string;
  created_at?: string;
  updated_at: string;
  no_ts?: boolean;
  messages: RawMessage[];
  attachments?: Record<string, { mime: string; b64: string }>;
}

const PLATFORM_NAME: Record<string, string> = {
  webchat: "网页聊天（AstrBot ChatUI）",
  weixin_personal_ewrj: "微信私聊",
};

function utcToBeijing(ts: string | undefined): string {
  if (!ts) return "";
  const d = new Date(String(ts).replace(" ", "T") + "Z");
  if (isNaN(d.getTime())) return String(ts).slice(0, 16);
  return new Date(d.getTime() + 8 * 3600 * 1000).toISOString().slice(0, 16).replace("T", " ");
}

function stripNoise(text: string): string {
  let value = text ?? "";
  value = value.replace(/<system_reminder>[\s\S]*?<\/system_reminder>\s*/g, "");
  value = value.replace(/\[Image from tool[^\]]*\]/g, "");
  return value.trim();
}

export function mdFileName(raw: RawSession): string {
  const title = (raw.title || "未命名会话").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim();
  return `会话-${raw.uuid}-${title.slice(0, 40)}.md`;
}

export async function buildConversationMd(env: Env, raw: RawSession): Promise<string> {
  const head: string[] = [];
  head.push("---");
  head.push("类型: 智能体会话记录");
  head.push(`会话编号: ${raw.conversation_id}`);
  head.push(`标题: ${(raw.title || "未命名会话").trim()}`);
  head.push(`来源: ${PLATFORM_NAME[raw.platform] ?? raw.platform}`);
  head.push(`开始时间: ${utcToBeijing(raw.created_at)}`);
  head.push(`最近更新: ${utcToBeijing(raw.updated_at)}`);
  head.push("说明: 智能体工具调用过程、思考过程、系统内部提醒已清理；图片/语音/文件按占位说明转写或列举。");
  if (raw.no_ts) head.push("注意: 本会话类型无逐条消息时间戳，仅标注会话级时间。");
  head.push("---");
  head.push("");
  head.push(`# ${(raw.title || "未命名会话").trim()}`);
  head.push("");

  for (const message of raw.messages) {
    const roleKnown = message.role === "user" || message.role === "bot" || message.role === "assistant";
    if (!roleKnown) continue;
    const role = message.role === "assistant" ? "bot" : message.role;
    const speaker = role === "user" ? "我（用户）" : "智能体";
    const lines = await partsToLines(env, role, speaker, message.parts ?? [], raw.attachments ?? {});
    if (!lines.length) continue;
    const time = raw.no_ts ? "" : utcToBeijing(message.ts);
    head.push(time ? `## ${time} ｜ ${speaker}` : `## ${speaker}`);
    head.push("");
    head.push(...lines);
    head.push("");
  }
  return head.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

async function partsToLines(
  env: Env, role: "user" | "bot", speaker: string, parts: RawPart[],
  attachments: Record<string, { mime: string; b64: string }>,
): Promise<string[]> {
  const lines: string[] = [];
  const textFragments: string[] = [];
  const filenames: string[] = [];
  const images: Array<{ mime: string; b64: string }> = [];

  for (const part of parts) {
    if ((part.type === "plain" || part.type === "text") && part.text != null) {
      const cleaned = stripNoise(part.text);
      if (cleaned) textFragments.push(cleaned);
    } else if (part.type === "image") {
      const a = resolveAsset(part, attachments);
      if (a) images.push(a); // 解析失败的图片由调用方计数兜底
      else images.push({ mime: "image/png", b64: "" });
    } else if (part.type === "file") {
      filenames.push(part.filename || "未知文件名");
    } else if (part.type === "record") {
      // 2026-11-03：语音不再转写，与文件一样只列名（附件本身已随会话保存）
      filenames.push(part.filename || "语音文件");
    }
  }

  if (textFragments.length) lines.push(textFragments.join("\n\n"));
  if (filenames.length) lines.push(`【（${speaker}发送了 ${filenames.length} 个文件）${filenames.map((n) => `文件名：${n}`).join("、")}】`);

  const usable = images.filter((i) => i.b64);
  const transcriptions = usable.length ? await transcribeImages(env, usable) : [];
  let cursor = 0;
  if (images.length) {
    const items = images.map((img) => img.b64 ? `图片${String(++cursor).padStart(2, "0")}转写为文本：${transcriptions[cursor - 1]}。` : "（图片不可读）");
    lines.push(`【（${speaker}发送了 ${images.length} 张图片）${items.join(" ")}】`);
  }

  return lines;
}

function resolveAsset(part: RawPart, attachments: Record<string, { mime: string; b64: string }>): { mime: string; b64: string } | null {
  if (part.attachment_id) return attachments[part.attachment_id] ?? null;
  if (part.b64) return { mime: part.mime || "application/octet-stream", b64: part.b64 };
  if (part.image_url?.url?.startsWith("data:")) {
    const m = part.image_url.url.match(/^data:([^;]+);base64,(.+)$/);
    if (m) return { mime: m[1], b64: m[2] };
  }
  return null;
}
