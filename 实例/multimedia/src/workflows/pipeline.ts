import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { Env } from "../env";
import {
  RELAY_BASE,
  extractBvid,
  fetchPlayUrl,
  fetchVideoInfo,
  resolveShortUrl,
  selectStreams,
  type Streams,
} from "../lib/bilibili";
import { fetchViaEgress, pipeViaEgress } from "../lib/egress";
import { detectBilibiliKind, detectPlatform, extractUrl } from "../lib/platform";
import { applyImageText, buildVisionRequest } from "../lib/images";
import { extractXhsUrl, parseXhsNote, renderXhsText } from "../lib/xiaohongshu";
import { extractSphUrl, parseSphDecrypt } from "../lib/shipinhao";
import { parseBiliOpus } from "../lib/bilibili-opus";

export interface PipelineParams {
  url?: string;
  fileUrl?: string;
  fileMime?: string;
  segs?: string;
}

type Json = Record<string, unknown>;

const READ_PAGE = "https://whimsical-belekoy-c4ebf6.netlify.app/read.html";

// celld 适配：单个步骤结果上限 1 MiB（OC 无此限制）。
// 网页/公众号正文可能很大，落进步骤结果前截断到 30 万字符（约 900KB UTF-8），
// 保证任何携带正文的步骤结果都不超限。持久化到 Supabase 的正文随之截断。
const MAX_STEP_TEXT = 300000;

const RULES =
  "第一段：先原样写出标记【标题】，紧接着写一个不超过二十字的内容标题。" +
  "第二段：换行后原样写出标记【概括】，紧接着用一段话概括整个视频讲了什么。" +
  "第三段：换行后原样写出标记【要点】，紧接着逐条列出提炼出来的要点，每条独占一行、不要在行首写序号。" +
  "第四段：换行后原样写出标记【标签】，紧接着写出三到五个主题标签，每个标签独占一行。" +
  "第五段：换行后原样写出标记【音频转写全文】，紧接着写音频的逐字完整转写；若只有环境音或音乐请说明其类型，若完全没有语音请直接写「无语音」，但仍要描述音频里有什么声音。全部用简体中文输出。";

const LEAD =
  "这是一段视频，它被拆成了两路：第一段是它的画面（无声），第二段是它的音频。请把它们当作同一个视频的组成部分，合起来完整理解，然后严格按下面五段输出，不要有任何开场白或额外解释。";

const SUMMARY_SYSTEM =
  "# 角色\n你是内容总结助手，负责把网页正文、文档文本或图片转写结果整理成结构化总结。\n\n" +
  "# 任务\n阅读用户提供的内容，按下列要求产出内容：\n" +
  "- title：内容标题，简洁准确\n" +
  "- summary：内容摘要，篇幅由你根据内容的信息量自行衡量，不要刻意压缩，也不要拘泥于字数限制，以讲清核心内容为准\n" +
  "- key_points：关键要点\n" +
  "- tags：主题标签\n\n" +
  "# 约束\n- 输出为简体中文\n- 中文和英语、中文和数字之间不要有空格\n" +
  "- 不要编造正文中没有的信息\n" +
  "- 如果正文无法阅读或内容为空，把 title 设为「无法读取内容」，summary 说明原因，key_points 与 tags 返回空";

function unwrap(value: unknown): Json {
  let data = ((value as { data?: unknown })?.data ?? {}) as Json;
  if (data && typeof data.data === "object" && data.data !== null) {
    data = data.data as Json;
  }
  return data;
}

// tikhub v2 的返回结构在 2026-11 前后发生变化：
// 旧版：data.content_noencode 直接是 HTML 字符串
// 新版：data.content 是一个对象，真正的 HTML 在它的 content_noencode 字段里
// 旧代码对对象做 String() 会得到 "[object Object]"（15 字符），导致正文提取为空
function pickWechatHtml(data: Json): string {
  if (typeof data.content_noencode === "string") return data.content_noencode;
  const inner = data.content;
  if (inner && typeof inner === "object") {
    const box = inner as Json;
    if (typeof box.content_noencode === "string") return box.content_noencode;
    if (typeof box.content === "string") return box.content;
  }
  if (typeof data.content === "string") return data.content;
  return "";
}

function extractWechatText(raw: string): string {
  try {
    const json = JSON.parse(raw) as { data?: Json };
    const data = unwrap(json);
    const html = pickWechatHtml(data);
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  } catch {
    return raw;
  }
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

async function compressIfNeeded(text: string): Promise<{ body: string; compressed: boolean }> {
  if (text.length <= 900000) return { body: text, compressed: false };
  try {
    const stream = new Blob([new TextEncoder().encode(text)])
      .stream()
      .pipeThrough(new CompressionStream("deflate"));
    const buffer = await new Response(stream).arrayBuffer();
    const packed = "Z1:" + base64FromBytes(new Uint8Array(buffer));
    return packed.length < text.length
      ? { body: packed, compressed: true }
      : { body: text, compressed: false };
  } catch {
    return { body: text, compressed: false };
  }
}

export class PipelineFlow extends WorkflowEntrypoint<Env, PipelineParams> {
  async run(event: WorkflowEvent<PipelineParams>, step: WorkflowStep) {
    const normalized = await step.do("normalize-link", async () => {
      const rawUrl = String(event.payload.url ?? "").trim();
      const fileUrl = String(event.payload.fileUrl ?? "").trim();
      if (!rawUrl && !fileUrl) throw new Error("empty url");
      if (!rawUrl && fileUrl) {
        return { url: fileUrl, platform: "file", bilibiliKind: null, fileMime: String(event.payload.fileMime ?? "application/pdf") };
      }
      const url = extractUrl(rawUrl);
      const platform = detectPlatform(url);
      return {
        url,
        platform,
        bilibiliKind: platform === "bilibili" ? detectBilibiliKind(url) : null,
      };
    });

    const dedupe = await step.do("dedupe", async () => {
      const res = await fetchViaEgress(
        this.env.EGRESS_URL,
        `https://tzfshyapcbfdicrghmtx.supabase.co/rest/v1/reading_items?select=id&source_url=eq.${encodeURIComponent(normalized.url)}&limit=1`,
        {
          headers: {
            apikey: this.env.SUPABASE_KEY,
            authorization: `Bearer ${this.env.SUPABASE_KEY}`,
          },
        },
      );
      return { exists: res.status === 200 && res.text.includes("\"id\"") };
    });

    if (dedupe.exists) {
      return { ...normalized, skipped: "duplicate" };
    }

    try {
      return await this.process(step, normalized);
    } catch (error) {
      await step.do("notify-error", async () => {
        const desp =
          `原始链接：${normalized.url}\n\n` +
          `结果：这条内容没能读取成功（${String(error).slice(0, 300)}），本条未做内容总结。`;
        return notify(this.env, "【内容总结】内容读取失败", desp);
      });
      throw error;
    }
  }

  private async process(
    step: WorkflowStep,
    normalized: { url: string; platform: string; bilibiliKind: string | null; fileMime?: string },
  ) {
    let text = "";
    let extra: Json = {};

    if (normalized.platform === "bilibili" && normalized.bilibiliKind === "opus") {
      const opus = await step.do(
        "bili-opus",
        { retries: { limit: 1, delay: 2000 } },
        async () => {
          const match = normalized.url.match(/\/opus\/(\d+)/);
          const opusId = match ? match[1] : "";
          if (!opusId) throw new NonRetryableError("opus id not found");
          const res = await fetchViaEgress(
            this.env.EGRESS_URL,
            `https://api.tikhub.io/api/v1/bilibili/web/fetch_dynamic_detail?dynamic_id=${encodeURIComponent(opusId)}`,
            { headers: { authorization: `Bearer ${this.env.TIKHUB_TOKEN}` } },
          );
          if (res.status !== 200) throw new NonRetryableError(`opus ${res.status}`);
          return parseBiliOpus(res.text);
        },
      );
      text = opus.text;
      extra = { opus: { title: opus.title, author: opus.author, images: opus.imgCount } };
    } else if (normalized.platform === "bilibili") {
      const resolved = await step.do("bili-resolve", { retries: { limit: 1, delay: 2000 } }, async () => {
        const raw = await resolveShortUrl(this.env.EGRESS_URL, this.env.RELAY_TOKEN, normalized.url);
        return { raw: raw.slice(0, 300), bvid: extractBvid(raw) || extractBvid(normalized.url) };
      });

      const info = await step.do("bili-info", { retries: { limit: 1, delay: 2000 } }, async () => {
        if (!resolved.bvid) throw new NonRetryableError("bvid not found");
        const json = await fetchVideoInfo(this.env.EGRESS_URL, this.env.TIKHUB_TOKEN, resolved.bvid);
        const data = unwrap(json);
        return {
          bvid: String(data.bvid ?? resolved.bvid),
          cid: String(data.cid ?? ""),
          title: String(data.title ?? ""),
          author: String((data.owner as Json)?.name ?? ""),
          desc: String(data.desc ?? "").trim().slice(0, 500),
        };
      });

      const play: Streams = await step.do("bili-playurl", { retries: { limit: 1, delay: 2000 } }, async () => {
        const json = await fetchPlayUrl(
          this.env.EGRESS_URL,
          this.env.TIKHUB_TOKEN,
          info.bvid,
          info.cid,
        );
        return selectStreams(json);
      });

      const video = await step.do("bili-relay-video", { retries: { limit: 1, delay: 2000 } }, async () => {
        const res = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-token": this.env.RELAY_TOKEN,
          },
          body: JSON.stringify({ url: play.vUrl, urls: [play.vUrl, play.vBack], tag: "bili-v" }),
        });
        const relay = JSON.parse(res.text) as { url?: string; bytes?: number; key?: string };
        if (!relay.url) throw new NonRetryableError(`relay video: ${res.text.slice(0, 200)}`);
        return { url: String(relay.url), bytes: Number(relay.bytes ?? 0), key: String(relay.key ?? "") };
      });

      const audio = await step.do("bili-relay-audio", { retries: { limit: 1, delay: 2000 } }, async () => {
        const res = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-token": this.env.RELAY_TOKEN,
          },
          body: JSON.stringify({ url: play.aUrl, urls: [play.aUrl, play.aBack], tag: "bili-a" }),
        });
        const relay = JSON.parse(res.text) as { url?: string; bytes?: number; key?: string };
        if (!relay.url) throw new NonRetryableError(`relay audio: ${res.text.slice(0, 200)}`);
        return { url: String(relay.url), bytes: Number(relay.bytes ?? 0), key: String(relay.key ?? "") };
      });

      const uploadVideo = await step.do("gemini-upload-video", async () =>
        uploadToGemini(this.env, video, "video/mp4", "bili-v"),
      );
      const uploadAudio = await step.do("gemini-upload-audio", async () =>
        uploadToGemini(this.env, audio, "audio/mp4", "bili-a"),
      );

      const prompt = await step.do("build-prompt", async () => {
        const head = [
          `【原视频标题】${info.title}`,
          `【作者】${info.author}`,
          `【视频简介】${info.desc || "（作者未写简介）"}`,
        ];
        return `${LEAD}\n${RULES}\n${head.join("\n")}`;
      });

      const answer = await step.do("gemini-generate", async () => {
        const ready = await waitActive(this.env, [uploadVideo.name, uploadAudio.name]);
        if (!ready) throw new Error("files not active");
        const body = {
          contents: [
            {
              parts: [
                { text: prompt },
                { fileData: { mimeType: "video/mp4", fileUri: uploadVideo.uri } },
                { fileData: { mimeType: "audio/mp4", fileUri: uploadAudio.uri } },
              ],
            },
          ],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 30000,
            thinkingConfig: { thinkingBudget: 0 },
          },
          safetySettings: [
            "HARM_CATEGORY_HATE_SPEECH",
            "HARM_CATEGORY_DANGEROUS_CONTENT",
            "HARM_CATEGORY_HARASSMENT",
            "HARM_CATEGORY_SEXUALLY_EXPLICIT",
            "HARM_CATEGORY_CIVIC_INTEGRITY",
          ].map((category) => ({ category, threshold: "OFF" })),
        };
        const res = await fetchViaEgress(
          this.env.EGRESS_URL,
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${this.env.GEMINI_KEY}`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
        );
        if (res.status !== 200) throw new Error(`generate ${res.status}: ${res.text.slice(0, 300)}`);
        const json = JSON.parse(res.text) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        const answerText = (json.candidates ?? [])
          .map((candidate) => (candidate.content?.parts ?? []).map((part) => part.text ?? "").join(""))
          .join("")
          .trim();
        return { text: answerText };
      });

      text = await step.do("assemble-text", async () => {
        const head = [`【作者】${info.author}`, `【视频简介】${info.desc || "（作者未写简介）"}`];
        return `${head.join("\n")}\n\n${answer.text}`.trim();
      });
      const cleanup = await step.do("bili-cleanup", async () => {
        const keys = [video.key, audio.key].filter(Boolean);
        if (!keys.length) return { status: 0, removed: 0 };
        const res = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/del`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-token": this.env.RELAY_TOKEN,
          },
          body: JSON.stringify({ keys }),
        });
        return { status: res.status, removed: keys.length, body: res.text.slice(0, 200) };
      });

      extra = { info, streams: { v: play.vInfo, a: play.aInfo }, cleanup };
    } else if (normalized.platform === "file") {
      const mime = String(normalized.fileMime ?? "application/pdf");
      const extracted = await step.do("file-extract", { retries: { limit: 1, delay: 2000 } }, async () => {
        const head = await fetchViaEgress(this.env.EGRESS_URL, normalized.url, { method: "HEAD" });
        const bytes = Number(head.headers["content-length"] ?? 0);
        if (!bytes) throw new NonRetryableError(`file size unknown (${head.status})`);
        const upload = await uploadToGemini(this.env, { url: normalized.url, bytes }, mime, "input-file");
        const ready = await waitActive(this.env, [upload.name]);
        if (!ready) throw new NonRetryableError("file not active");
        const prompt = mime.startsWith("audio")
          ? "请把这段音频完整、准确地转写成文字；如果没有人声、只有音乐或环境音，请描述音频内容与特征。只输出转写结果。"
          : "请完整提取这份文档里的全部文字，保持原有段落与层级；如果是图片，请把图中文字一字不差地抄下来，并简述画面。只输出提取结果。";
        const body = {
          contents: [{ parts: [{ text: prompt }, { fileData: { mimeType: mime, fileUri: upload.uri } }] }],
          generationConfig: { temperature: 0, maxOutputTokens: 30000 },
        };
        const res = await fetchViaEgress(
          this.env.EGRESS_URL,
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${this.env.GEMINI_KEY}`,
          { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
        );
        if (res.status !== 200) throw new NonRetryableError(`file extract ${res.status}`);
        const json = JSON.parse(res.text) as {
          candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        };
        return {
          mime,
          bytes,
          text: (json.candidates ?? [])
            .map((candidate) => (candidate.content?.parts ?? []).map((part) => part.text ?? "").join(""))
            .join("")
            .trim(),
        };
      });

      text = extracted.text;
      extra = { file: { mime: extracted.mime, bytes: extracted.bytes, length: text.length } };
      if (!text) throw new NonRetryableError("file text empty");
    } else if (normalized.platform === "xiaohongshu") {
      const target = extractXhsUrl(normalized.url);
      const page = await step.do(
        "xhs-page",
        { retries: { limit: 1, delay: 2000 } },
        async () => {
          const res = await fetchViaEgress(this.env.EGRESS_URL, target, {
            headers: {
              "user-agent":
                "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
            },
          });
          return { status: res.status, text: res.text };
        },
      );

      let note = parseXhsNote(page.text);
      if (!note.images.length && !note.video) {
        const api = await step.do(
          "xhs-api",
          { retries: { limit: 1, delay: 2000 } },
          async () => {
            const res = await fetchViaEgress(
              this.env.EGRESS_URL,
              `https://api.tikhub.io/api/v1/xiaohongshu/app_v2/get_image_note_detail?share_text=${encodeURIComponent(target)}`,
              { headers: { authorization: `Bearer ${this.env.TIKHUB_TOKEN}` } },
            );
            return { status: res.status, text: res.text };
          },
        );
        note = parseXhsNote("", api.text);
      }

      text = renderXhsText(note);
      extra = { xhs: { title: note.title, images: note.images.length, hasVideo: !!note.video, source: note.source } };

      if (note.video) {
        const video = await step.do(
          "xhs-video",
          { retries: { limit: 1, delay: 2000 } },
          async () => {
            const relay = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                "x-relay-token": this.env.RELAY_TOKEN,
              },
              body: JSON.stringify({ url: note.video, urls: [note.video, note.videoB].filter(Boolean), tag: "xhs" }),
            });
            const stored = JSON.parse(relay.text) as { url?: string; bytes?: number };
            if (!stored.url) throw new NonRetryableError(`xhs relay: ${relay.text.slice(0, 160)}`);
            return geminiVideo(this.env, { url: String(stored.url), bytes: Number(stored.bytes ?? 0) }, note.title, note.desc);
          },
        );
        text = [text, video.text].filter(Boolean).join("\n\n");
      }

      if (!text) throw new NonRetryableError("xhs content empty");
    } else if (normalized.platform === "shipinhao") {
      const shareUrl = extractSphUrl(normalized.url);
      const decrypt = await step.do(
        "sph-decrypt",
        { retries: { limit: 1, delay: 2000 } },
        async () => {
          const res = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-relay-token": this.env.RELAY_TOKEN,
            },
            body: JSON.stringify({ share_url: shareUrl, tag: "sph" }),
          });
          return parseSphDecrypt(res.text);
        },
      );
      if (!decrypt.url) throw new NonRetryableError(decrypt.err || "sph decrypt failed");

      const video = await step.do(
        "sph-video",
        { retries: { limit: 1, delay: 2000 } },
        async () => geminiVideo(this.env, { url: decrypt.url, bytes: decrypt.bytes }, decrypt.title, ""),
      );
      text = [decrypt.title ? `【标题】${decrypt.title}` : "", video.text].filter(Boolean).join("\n\n");
      extra = { sph: { title: decrypt.title, key: decrypt.key } };

      await step.do("sph-cleanup", async () => {
        if (!decrypt.key) return { status: 0 };
        const res = await fetchViaEgress(this.env.EGRESS_URL, `${RELAY_BASE}/del`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-relay-token": this.env.RELAY_TOKEN,
          },
          body: JSON.stringify({ key: decrypt.key }),
        });
        return { status: res.status };
      });
    } else {
      const content = await step.do("fetch-content", { retries: { limit: 1, delay: 2000 } }, async () => {
        if (normalized.platform === "web") {
          const res = await fetchViaEgress(this.env.EGRESS_URL, `https://r.jina.ai/${normalized.url}`, {
            headers: { accept: "text/plain" },
          });
          if (res.status !== 200) throw new Error(`jina ${res.status}`);
          const body = res.text.slice(0, MAX_STEP_TEXT);
          return { kind: "web", length: res.text.length, text: body, truncated: res.text.length > body.length };
        }
        if (normalized.platform === "wechat_article") {
          const res = await fetchViaEgress(
            this.env.EGRESS_URL,
            "https://api.tikhub.io/api/v1/wechat_mp/v2/fetch_article_detail_h5",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.env.TIKHUB_TOKEN}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({ url: normalized.url }),
            },
          );
          const full = extractWechatText(res.text);
          const body = full.slice(0, MAX_STEP_TEXT);
          return { kind: "wechat_article", length: full.length, text: body, truncated: full.length > body.length };
        }
        return { kind: normalized.platform, length: 0, text: "", skipped: true };
      });
      text = content.text;
      extra = { content: { kind: content.kind, length: content.length, skipped: content.skipped ?? false } };
    }

    if (!text) {
      return { ...normalized, ...extra, error: "no text extracted" };
    }

    const vision = await step.do(
      "read-images",
      { retries: { limit: 1, delay: 2000 } },
      async () => {
        const req = buildVisionRequest(text);
        if (req.sent === 0) return { skipped: true, total: req.total, sent: 0, skippedCount: req.skipped };
        try {
          const res = await fetchViaEgress(
            this.env.EGRESS_URL,
            "https://shapi.vip/v1/chat/completions",
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${this.env.SHAPI_KEY}`,
                "content-type": "application/json",
              },
              body: req.body,
            },
            180000,
          );
          if (res.status !== 200) {
            return { skipped: true, total: req.total, sent: req.sent, skippedCount: req.skipped, error: `vision ${res.status}` };
          }
          const json = JSON.parse(res.text) as {
            choices?: Array<{ message?: { content?: string } }>;
          };
          const answer = json.choices?.[0]?.message?.content ?? "";
          return { skipped: false, total: req.total, sent: req.sent, skippedCount: req.skipped, answer };
        } catch (error) {
          return { skipped: true, total: req.total, sent: req.sent, skippedCount: req.skipped, error: String(error).slice(0, 200) };
        }
      },
    );

    if (!vision.skipped && vision.answer) {
      text = applyImageText(text, vision.answer);
    }

    const summary = await step.do("summarize", { retries: { limit: 1, delay: 2000 } }, async () => summarize(this.env, text));

    const saved = await step.do("persist", async () =>
      persist(this.env, { text, sourceUrl: normalized.url, summary }),
    );

    const notice = await step.do("notify", async () => {
      const lines = [
        summary.title,
        "",
        `完整原文：[点此打开完整原文](${saved.readUrl})`,
        "",
        summary.summary,
        "",
      ];
      summary.key_points.forEach((point, index) => lines.push(`${index + 1}. ${point}`));
      return notify(this.env, "【内容总结】待阅读", lines.join("\n"));
    });

    return { ...normalized, ...extra, vision: { total: vision.total, sent: vision.sent, skipped: vision.skipped, error: vision.error ?? null }, summary, saved, notice };
  }
}

async function summarize(
  env: Env,
  text: string,
): Promise<{ title: string; summary: string; key_points: string[]; tags: string[] }> {
  const body = {
    systemInstruction: { parts: [{ text: SUMMARY_SYSTEM }] },
    contents: [{ role: "user", parts: [{ text: text.slice(0, MAX_STEP_TEXT) }] }],
    generationConfig: {
      temperature: 0,
      responseMimeType: "application/json",
      responseSchema: {
        type: "OBJECT",
        properties: {
          title: { type: "STRING" },
          summary: { type: "STRING" },
          key_points: { type: "ARRAY", items: { type: "STRING" } },
          tags: { type: "ARRAY", items: { type: "STRING" } },
        },
        required: ["title", "summary", "key_points", "tags"],
      },
    },
  };
  const res = await fetchViaEgress(
    env.EGRESS_URL,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${env.GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (res.status !== 200) throw new Error(`summary ${res.status}: ${res.text.slice(0, 300)}`);
  const json = JSON.parse(res.text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const raw = (json.candidates ?? [])
    .map((candidate) => (candidate.content?.parts ?? []).map((part) => part.text ?? "").join(""))
    .join("");
  let parsed: Json = {};
  try {
    parsed = JSON.parse(raw) as Json;
  } catch {
    parsed = {};
  }
  const list = (value: unknown): string[] =>
    Array.isArray(value) ? value.map(String) : value ? [String(value)] : [];
  return {
    title: String(parsed.title ?? ""),
    summary: String(parsed.summary ?? ""),
    key_points: list(parsed.key_points),
    tags: list(parsed.tags),
  };
}

async function persist(
  env: Env,
  input: {
    text: string;
    sourceUrl: string;
    summary: { title: string; summary: string; key_points: string[]; tags: string[] };
  },
): Promise<{ id: string; readUrl: string; compressed: boolean; bytes: number }> {
  const { body, compressed } = await compressIfNeeded(input.text);
  const id = crypto.randomUUID();
  const payload = {
    id,
    source_url: input.sourceUrl,
    submission_id: "",
    title: input.summary.title,
    summary: input.summary.summary,
    key_points: input.summary.key_points,
    tags: input.summary.tags,
    original_text: body,
  };
  const res = await fetchViaEgress(
    env.EGRESS_URL,
    "https://tzfshyapcbfdicrghmtx.supabase.co/rest/v1/reading_items",
    {
      method: "POST",
      headers: {
        apikey: env.SUPABASE_KEY,
        authorization: `Bearer ${env.SUPABASE_KEY}`,
        "content-type": "application/json",
        prefer: "return=minimal",
      },
      body: JSON.stringify(payload),
    },
  );
  if (res.status >= 300) throw new Error(`supabase ${res.status}: ${res.text.slice(0, 200)}`);
  return { id, readUrl: `${READ_PAGE}?id=${id}`, compressed, bytes: body.length };
}

async function notify(env: Env, title: string, desp: string): Promise<{ status: number; body: string }> {
  const body = new URLSearchParams({ title, desp }).toString();
  const res = await fetchViaEgress(env.EGRESS_URL, env.SERVERCHAN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  return { status: res.status, body: res.text.slice(0, 200) };
}

async function uploadToGemini(
  env: Env,
  media: { url: string; bytes: number },
  mimeType: string,
  displayName: string,
): Promise<{ name: string; uri: string }> {
  const start = await fetchViaEgress(
    env.EGRESS_URL,
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_KEY}`,
    {
      method: "POST",
      headers: {
        "x-goog-upload-protocol": "resumable",
        "x-goog-upload-command": "start",
        "x-goog-upload-header-content-length": String(media.bytes),
        "x-goog-upload-header-content-type": mimeType,
        "content-type": "application/json",
      },
      body: JSON.stringify({ file: { display_name: displayName } }),
    },
  );
  const uploadUrl = start.headers["x-goog-upload-url"];
  if (!uploadUrl) throw new Error(`no upload url (${start.status}): ${start.text.slice(0, 200)}`);
  const pipe = await pipeViaEgress(env.EGRESS_URL, media.url, uploadUrl, {
    "x-goog-upload-offset": "0",
    "x-goog-upload-command": "upload, finalize",
  });
  const parsed = JSON.parse(pipe.text) as { file?: { name?: string; uri?: string } };
  if (!parsed.file?.name || !parsed.file?.uri) {
    throw new Error(`upload failed (${pipe.status}): ${pipe.text.slice(0, 200)}`);
  }
  return { name: parsed.file.name, uri: parsed.file.uri };
}

async function waitActive(env: Env, names: string[]): Promise<boolean> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    let pending = false;
    for (const name of names) {
      const res = await fetchViaEgress(
        env.EGRESS_URL,
        `https://generativelanguage.googleapis.com/v1beta/${name}?key=${env.GEMINI_KEY}`,
      );
      if (res.status !== 200) return false;
      const state = (JSON.parse(res.text) as { state?: string }).state;
      if (state !== "ACTIVE") pending = true;
    }
    if (!pending) return true;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return false;
}

async function geminiVideo(
  env: Env,
  media: { url: string; bytes: number },
  title: string,
  desc: string,
): Promise<{ text: string }> {
  if (!media.bytes) throw new NonRetryableError("video bytes missing");
  const upload = await uploadToGemini(env, media, "video/mp4", "video");
  const ready = await waitActive(env, [upload.name]);
  if (!ready) throw new NonRetryableError("video file not active");
  const prompt = `${LEAD}
${RULES}
【标题】${title || "（未提供）"}
【简介】${desc || "（未提供）"}`;
  const body = {
    contents: [
      {
        parts: [
          { text: prompt },
          { fileData: { mimeType: "video/mp4", fileUri: upload.uri } },
        ],
      },
    ],
    generationConfig: {
      temperature: 0,
      maxOutputTokens: 30000,
      thinkingConfig: { thinkingBudget: 0 },
    },
    safetySettings: [
      "HARM_CATEGORY_HATE_SPEECH",
      "HARM_CATEGORY_DANGEROUS_CONTENT",
      "HARM_CATEGORY_HARASSMENT",
      "HARM_CATEGORY_SEXUALLY_EXPLICIT",
      "HARM_CATEGORY_CIVIC_INTEGRITY",
    ].map((category) => ({ category, threshold: "OFF" })),
  };
  const res = await fetchViaEgress(
    env.EGRESS_URL,
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${env.GEMINI_KEY}`,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
  );
  if (res.status !== 200) throw new NonRetryableError(`gemini video ${res.status}: ${res.text.slice(0, 200)}`);
  const json = JSON.parse(res.text) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
  };
  const text = (json.candidates ?? [])
    .map((candidate) => (candidate.content?.parts ?? []).map((part) => part.text ?? "").join(""))
    .join("")
    .trim();
  return { text };
}
