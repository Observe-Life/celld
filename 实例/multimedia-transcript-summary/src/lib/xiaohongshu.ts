export interface XhsNote {
  title: string;
  desc: string;
  images: string[];
  video: string;
  videoB: string;
  videoC: string;
  source: string;
}

export function extractXhsUrl(raw: string): string {
  const match = raw.match(/https?:\/\/[^\s，,。；;、）)\]"]+/);
  return match ? match[0] : raw.trim();
}

export function parseXhsNote(html: string, apiJson?: string): XhsNote {
  const note: XhsNote = { title: "", desc: "", images: [], video: "", videoB: "", videoC: "", source: "" };
  if (html) {
    const match = html.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*<\/script>/);
    if (match) {
      try {
        const state = JSON.parse(match[1].replace(/undefined/g, "null")) as Record<string, unknown>;
        const noteData = (((state as any)?.noteData ?? {})?.data ?? {})?.noteData ?? {};
        note.title = String(noteData.title ?? "").trim();
        note.desc = String(noteData.desc ?? "").trim();
        for (const item of (noteData.imageList ?? []) as Array<Record<string, unknown>>) {
          const url = String(item?.url ?? "").trim();
          if (url) note.images.push(url);
        }
        const stream = (((noteData.video ?? {})?.media ?? {})?.stream ?? {}) as Record<string, Array<Record<string, unknown>>>;
        const rows: Array<{ br: number; master: string; bak: string[] }> = [];
        for (const list of Object.values(stream)) {
          for (const entry of list ?? []) {
            const master = String(entry?.masterUrl ?? "");
            if (!master) continue;
            rows.push({
              br: Number(entry?.avgBitrate ?? 1e9) || 1e9,
              master,
              bak: ((entry?.backupUrls ?? []) as string[]).filter(Boolean),
            });
          }
        }
        rows.sort((a, b) => a.br - b.br);
        if (rows.length) {
          const best = rows[0];
          const candidates: string[] = [];
          for (const url of best.bak) if (url && !candidates.includes(url)) candidates.push(url);
          if (best.master && !candidates.includes(best.master)) candidates.push(best.master);
          note.video = candidates[0] ?? "";
          note.videoB = candidates[1] ?? "";
          note.videoC = candidates[2] ?? "";
        }
        if (note.images.length || note.desc || note.video) note.source = "页面";
      } catch {
        /* fall through to api */
      }
    }
  }
  if (!note.images.length && !note.video && apiJson) {
    try {
      const payload = JSON.parse(apiJson) as Record<string, unknown>;
      const list = (((payload as any)?.data ?? {})?.data ?? [{}])[0]?.note_list ?? [];
      const item = (list as Array<Record<string, unknown>>)[0] ?? {};
      if (item && item.id) {
        note.title = String(item.title ?? "").trim() || note.title;
        note.desc = String(item.desc ?? "").trim() || note.desc;
        for (const image of (item.images_list ?? []) as Array<Record<string, unknown>>) {
          const url = String(image?.url ?? "").trim();
          if (url) note.images.push(url);
        }
        note.source = "接口";
      }
    } catch {
      /* ignore */
    }
  }
  return note;
}

export function renderXhsText(note: XhsNote): string {
  const lines: string[] = [];
  if (note.title) {
    lines.push("# " + note.title, "");
  }
  if (note.desc) {
    lines.push(note.desc, "");
  }
  for (const url of note.images) {
    lines.push(`![](${url})`);
  }
  return lines.join("\n").trim();
}
