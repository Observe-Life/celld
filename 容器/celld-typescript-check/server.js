// celld 类型检查服务：POST /check {files:{路径:源码}, ambient?:string} → 诊断清单
// 内存纪律：每请求全新 Program（用完即被 GC，无 LanguageService 缓存泄漏）；
//          skipLibCheck；lib 链按需从磁盘读取（容器内有完整 typescript 包）。
const http = require("http");
const ts = require("typescript");
const fs = require("fs");
const path = require("path");

const LIBDIR = path.join(path.dirname(require.resolve("typescript")), "lib");
const LIBS = new Map();
function lib(name) {
  if (LIBS.has(name)) return LIBS.get(name);
  for (const cand of [name, name + ".d.ts", "lib." + name, "lib." + name + ".d.ts"]) {
    const p = path.join(LIBDIR, cand);
    if (fs.existsSync(p)) { const t = fs.readFileSync(p, "utf8"); LIBS.set(name, t); return t; }
  }
  return undefined;
}
function chain(start) { const t = lib(start); if (t) for (const m of t.matchAll(/\/\/\/ *<reference lib="([^"]+)"/g)) lib(m[1]); }
try { chain("lib.es2022.d.ts"); chain("lib.webworker.d.ts"); } catch (e) { console.error("[ts-check] lib 初始化失败:", e.message); }
let WT = ""; try { WT = fs.readFileSync(require.resolve("@cloudflare/workers-types/index.d.ts"), "utf8"); LIBS.set("workers-types.d.ts", WT); } catch (e) { console.error("[ts-check] workers-types 读取失败:", e.message); }
LIBS.set("workers-types.d.ts", WT);

http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200); return res.end('{"ok":true,"service":"ts-check"}'); }
  if (req.method !== "POST" || req.url !== "/check") { res.writeHead(404); return res.end(); }
  let body = ""; req.on("data", c => body += c);
  req.on("end", () => {
    try {
      const { files, ambient } = JSON.parse(body);
      if (!files || !Object.keys(files).length) { res.writeHead(400); return res.end('{"ok":false,"error":"no files"}'); }
      const contents = new Map(Object.entries(files));
      for (const [k, v] of LIBS) if (!contents.has(k)) contents.set(k, v);
      if (ambient) contents.set("(ambient).d.ts", ambient);
      const rootNames = [...Object.keys(files), "workers-types.d.ts", ...(ambient ? ["(ambient).d.ts"] : [])];
      const options = { strict: true, noEmit: true, target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler,
        skipLibCheck: true, noUncheckedIndexedAccess: true, exactOptionalPropertyTypes: true,
        noImplicitReturns: true, types: [], lib: ["es2022", "webworker"] };
      const host = {
        getSourceFile: (n, lv) => { const base = n.replace(/^\//, ""); const t = contents.get(n) ?? contents.get(base) ?? LIBS.get(base) ?? LIBS.get("lib." + base);
          return t === undefined ? undefined : ts.createSourceFile(n, t, lv, true); },
        fileExists: (n) => { const base = n.replace(/^\//, ""); return contents.has(n) || contents.has(base) || LIBS.has(base) || LIBS.has("lib." + base); },
        readFile: (n) => { const base = n.replace(/^\//, ""); return contents.get(n) ?? contents.get(base) ?? LIBS.get(base) ?? LIBS.get("lib." + base); },
        directoryExists: () => true, getDirectories: () => [], getCurrentDirectory: () => "/",
        getCanonicalFileName: (n) => n, getNewLine: () => "\n", useCaseSensitiveFileNames: () => true,
        getDefaultLibFileName: () => "lib.es2022.d.ts", getDefaultLibLocation: () => "", writeFile: () => {},
      };
      const program = ts.createProgram({ rootNames, options, host });
      const diags = ts.getPreEmitDiagnostics(program).map(dg => {
        const f = dg.file ? dg.file.fileName : "(compiler)";
        const pos = dg.file ? dg.file.getLineAndCharacterOfPosition(dg.start ?? 0) : { line: 0, character: 0 };
        return { file: f, line: pos.line + 1, col: pos.character + 1, code: dg.code,
                 severity: dg.category === ts.DiagnosticCategory.Error ? "error" : "warning",
                 message: ts.flattenDiagnosticMessageText(dg.messageText, " ") };
      });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, errors: diags.filter(d => d.severity === "error").length, diagnostics: diags }));
    } catch (e) { res.writeHead(500); res.end(JSON.stringify({ ok: false, error: String(e).slice(0, 200) })); }
  });
}).listen(8080, () => console.log("[ts-check] listening :8080"));
