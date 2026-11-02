export interface BiliOpus {
  title: string;
  author: string;
  text: string;
  imgCount: number;
}

function nodesText(nodes: unknown): string {
  let out = "";
  for (const node of (nodes ?? []) as Array<Record<string, unknown>>) {
    const word = ((node ?? {}) as any)?.word ?? {};
    if (word?.words) out += String(word.words);
  }
  return out;
}

export function parseBiliOpus(body: string): BiliOpus {
  const out: BiliOpus = { title: "", author: "", text: "", imgCount: 0 };
  try {
    const payload = JSON.parse(body) as Record<string, unknown>;
    let data = ((payload as any)?.data ?? {}) as Record<string, unknown>;
    if (data && typeof data.data === "object") data = data.data as Record<string, unknown>;
    const item = ((data as any)?.item ?? {}) as Record<string, unknown>;
    const modules = ((item as any)?.modules ?? []) as Array<Record<string, unknown>>;
    let content: Record<string, unknown> = {};
    for (const module of modules) {
      const type = module.module_type;
      if (type === "MODULE_TYPE_CONTENT") content = (module.module_content ?? {}) as Record<string, unknown>;
      else if (type === "MODULE_TYPE_AUTHOR") out.author = String(((module.module_author ?? {}) as any)?.name ?? "");
      else if (type === "MODULE_TYPE_TITLE") out.title = String(((module.module_title ?? {}) as any)?.text ?? out.title);
    }
    const lines: string[] = [];
    const images: string[] = [];
    for (const para of ((content as any)?.paragraphs ?? []) as Array<Record<string, unknown>>) {
      const paraType = para.para_type;
      if (paraType === 1 || paraType === 8) {
        const source = (para.text ?? para.heading ?? {}) as Record<string, unknown>;
        const text = nodesText(source.nodes).trim();
        if (text) lines.push((paraType === 8 ? "## " : "") + text);
      }
      for (const pic of (((para as any)?.pic ?? {})?.pics ?? []) as Array<Record<string, unknown>>) {
        let url = String((pic ?? {}).url ?? "");
        if (!url) continue;
        if (url.startsWith("//")) url = "https:" + url;
        images.push(url.replace("http://", "https://"));
      }
    }
    out.imgCount = images.length;
    const head = ["【标题】" + out.title];
    if (out.author) head.push("【作者】" + out.author);
    const parts = [...head, "", lines.join("\n")];
    for (const url of images) parts.push(`![](${url})`);
    out.text = parts.join("\n").trim();
  } catch {
    out.text = "";
  }
  return out;
}
