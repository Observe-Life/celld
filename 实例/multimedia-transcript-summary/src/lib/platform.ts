export type Platform =
  | "bilibili"
  | "wechat_article"
  | "xiaohongshu"
  | "shipinhao"
  | "xiaoyuzhou"
  | "web";

const URL_PATTERN = /https?:\/\/[^\s，,。；;、）)】]+/;

export function extractUrl(text: string): string {
  const match = text.match(URL_PATTERN);
  return (match ? match[0] : text).trim();
}

export function detectPlatform(url: string): Platform {
  const value = url.toLowerCase();
  if (value.includes("bilibili.com") || value.includes("b23.tv")) return "bilibili";
  if (value.includes("mp.weixin.qq.com")) return "wechat_article";
  if (value.includes("xiaohongshu.com") || value.includes("xhslink.com")) return "xiaohongshu";
  if (value.includes("weixin.qq.com/sph") || value.includes("channels.weixin.qq.com")) {
    return "shipinhao";
  }
  if (value.includes("xiaoyuzhoufm.com/episode/")) return "xiaoyuzhou";
  return "web";
}

export function detectBilibiliKind(url: string): "opus" | "video" | "unknown" {
  if (/\/opus\/\d+/.test(url)) return "opus";
  if (/BV[A-Za-z0-9]{10}/.test(url)) return "video";
  if (url.toLowerCase().includes("b23.tv")) return "unknown";
  return "unknown";
}
