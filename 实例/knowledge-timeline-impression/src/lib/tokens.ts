// 查询词提取：与 rag-ferrite 的 src/storage/fts_text.rs 同口径
//（汉字段出单字+相邻双字；ASCII 段整词小写并保留 _ + . / -；标点断开）。
//
// 为什么不用 FTS5：时间轴当前 854 行、万级以内，LIKE 足够；且 trigram 分词器
// 对 <3 字查询静默失效（P0 冒烟结论），此前"整句拿去 LIKE"又会撞
// 「LIKE or GLOB pattern too complex」。所以统一改为：先把查询切成短词元，
// 再对 snippet 做 OR-LIKE，词元长度受控，模式不会过复杂。
// tsconfig 开了 noUncheckedIndexedAccess 与 exactOptionalPropertyTypes。
const CJK = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\uAC00-\uD7AF]/u;
const WORD = /[A-Za-z0-9_+./-]/;

export function isIdeograph(ch: string): boolean {
  return CJK.test(ch);
}

/** 把查询切成词元：汉字=单字+相邻双字，ASCII=整词（小写）。最多返回 max 个。 */
export function queryTerms(q: string, max = 6): string[] {
  const out: string[] = [];
  let cjkRun = "";
  let wordRun = "";
  const flushWord = (): void => {
    if (wordRun) { out.push(wordRun.toLowerCase()); wordRun = ""; }
  };
  const flushCjk = (): void => {
    // 不用下标访问：noUncheckedIndexedAccess 下 cs[i] 是 string | undefined
    let prev: string | undefined;
    for (const ch of cjkRun) {
      out.push(ch);
      if (prev !== undefined) out.push(prev + ch);
      prev = ch;
    }
    cjkRun = "";
  };
  for (const ch of q) {
    if (CJK.test(ch)) { flushWord(); cjkRun += ch; }
    else if (WORD.test(ch)) { flushCjk(); wordRun += ch; }
    else { flushWord(); flushCjk(); }
  }
  flushWord(); flushCjk();
  const seen = new Set<string>();
  const res: string[] = [];
  for (const t of out) {
    if (!seen.has(t)) { seen.add(t); res.push(t); }
  }
  return res.slice(0, Math.max(1, max));
}
