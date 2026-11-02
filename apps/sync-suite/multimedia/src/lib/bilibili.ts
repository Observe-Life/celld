import { fetchViaEgress } from "./egress";

export const RELAY_BASE = "https://sph-relay.bc-l.workers.dev";

export interface Streams {
  vUrl: string;
  vBack: string;
  aUrl: string;
  aBack: string;
  vInfo: string;
  aInfo: string;
  nVideo: number;
  nAudio: number;
}

function pickLowestBandwidth(list: Array<Record<string, unknown>>): Record<string, unknown> {
  return list.reduce((best, item) => {
    const bw = Number(item.bandwidth ?? 0) || 0;
    const bestBw = Number(best.bandwidth ?? 0) || 0;
    return bw <= bestBw ? item : best;
  }, list[0] ?? {});
}

export function selectStreams(payload: unknown): Streams {
  let data = (payload as { data?: Record<string, unknown> })?.data ?? {};
  if (data && typeof data.data === "object") data = data.data as Record<string, unknown>;
  const dash = ((data?.dash ?? {}) as Record<string, unknown>) as {
    video?: Array<Record<string, unknown>>;
    audio?: Array<Record<string, unknown>>;
  };
  const videos = (dash.video ?? []).filter((item) => String(item.baseUrl ?? item.base_url ?? ""));
  const audios = (dash.audio ?? []).filter((item) => String(item.baseUrl ?? item.base_url ?? ""));
  const avc = videos.filter((item) => String(item.codecs ?? "").toLowerCase().startsWith("avc1"));
  const video = pickLowestBandwidth(avc.length ? avc : videos);
  const audio = pickLowestBandwidth(audios);
  const backup = (item: Record<string, unknown>) => {
    const urls = (item.backupUrl ?? item.backup_url ?? []) as string[];
    return urls.length ? String(urls[0]) : "";
  };
  return {
    vUrl: String(video.baseUrl ?? video.base_url ?? ""),
    vBack: backup(video),
    aUrl: String(audio.baseUrl ?? audio.base_url ?? ""),
    aBack: backup(audio),
    vInfo: video.width ? `${video.width}x${video.height} ${video.codecs ?? ""}` : "",
    aInfo: String(audio.codecs ?? ""),
    nVideo: videos.length,
    nAudio: audios.length,
  };
}

export async function resolveShortUrl(
  egressUrl: string,
  relayToken: string,
  url: string,
): Promise<string> {
  const res = await fetchViaEgress(
    egressUrl,
    `${RELAY_BASE}/resolve?url=${encodeURIComponent(url)}`,
    { headers: { "x-relay-token": relayToken } },
  );
  if (res.status !== 200) throw new Error(`relay resolve ${res.status}`);
  return res.text;
}

export async function fetchVideoInfo(
  egressUrl: string,
  token: string,
  bvid: string,
): Promise<Record<string, unknown>> {
  const res = await fetchViaEgress(
    egressUrl,
    `https://api.tikhub.io/api/v1/bilibili/web/fetch_one_video?bv_id=${encodeURIComponent(bvid)}`,
    { headers: { authorization: `Bearer ${token}` } },
    45000,
  );
  if (res.status !== 200) throw new Error(`tikhub info ${res.status}`);
  return JSON.parse(res.text) as Record<string, unknown>;
}

export async function fetchPlayUrl(
  egressUrl: string,
  token: string,
  bvid: string,
  cid: string,
): Promise<Record<string, unknown>> {
  const res = await fetchViaEgress(
    egressUrl,
    `https://api.tikhub.io/api/v1/bilibili/web/fetch_video_playurl?bv_id=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (res.status !== 200) throw new Error(`tikhub playurl ${res.status}`);
  return JSON.parse(res.text) as Record<string, unknown>;
}

export function extractBvid(text: string): string {
  const match = text.match(/BV[A-Za-z0-9]{10}/);
  return match ? match[0] : "";
}
