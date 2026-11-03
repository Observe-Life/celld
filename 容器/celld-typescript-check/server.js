// celld-typescript-check：常驻待命的 TS 类型检查服务（平时由 celld-wake-container 停着，唤醒时干活）
//
// 接口：POST /check {files: {"相对路径": "源码", ...}, compilerOptions?: {...}} 
//       → {ok, errors, warnings, diagnostics:[{file,line,col,code,severity,message}]}
//       GET  /health → {ok:true, service, typescript}
//
// 实现口径（重要）：把收到的源码落到 /app/run/<请求id>/ 真实目录，再用 TypeScript 标准
// CompilerHost（ts.sys）从磁盘解析。lib/*.d.ts、node_modules、types 全由编译器自己按
// 官方机制查找，与 `tsc -p` 完全同一条路径，因此本文件不手写任何 lib 文件名映射、
// 不做任何前缀兜底。之前 205 条 "Cannot find global type" 就是手写映射拼错 lib 目录导致的。
const http = require("http");
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const RUN_ROOT = "/app/run";
const MAX_BODY_BYTES = 8 * 1024 * 1024;

// 与实例 tsconfig.json 保持同一口径（wrangler 生成的也是这套）
const DEFAULT_COMPILER_OPTIONS = {
  strict: true,
  noEmit: true,
  target: "ES2022",
  module: "ESNext",
  moduleResolution: "Bundler",
  lib: ["ES2022", "WebWorker"],
  types: ["@cloudflare/workers-types"],
  skipLibCheck: true,
  noUncheckedIndexedAccess: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json; charset=utf-8" });
  res.end(body);
}

// 每个请求一个独立临时目录，用完即删：无跨请求缓存，内存占用只有单次 Program
function runCheck(files, compilerOptions) {
  const dir = fs.mkdtempSync(path.join(RUN_ROOT, "req-"));
  try {
    const names = Object.keys(files);
    if (!names.length) throw new Error("no files");
    for (const name of names) {
      if (path.isAbsolute(name) || name.split("/").includes("..")) {
        throw new Error("unsafe path: " + name);
      }
      const target = path.join(dir, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, String(files[name]), "utf8");
    }

    const config = {
      compilerOptions: Object.assign({}, DEFAULT_COMPILER_OPTIONS, compilerOptions || {}),
      include: ["**/*.ts", "**/*.d.ts"],
    };
    fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify(config, null, 2), "utf8");

    const parsed = ts.parseJsonConfigFileContent(config, ts.sys, dir);
    const options = parsed.options;
    const host = ts.createCompilerHost(options, true);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options, host });

    const prefix = dir + path.sep;
    const diagnostics = ts
      .getPreEmitDiagnostics(program)
      .map((dg) => {
        const fileName = dg.file ? dg.file.fileName.replace(prefix, "") : "(program)";
        let line = 1;
        let col = 1;
        if (dg.file && typeof dg.start === "number") {
          const pos = dg.file.getLineAndCharacterOfPosition(dg.start);
          line = pos.line + 1;
          col = pos.character + 1;
        }
        return {
          file: fileName,
          line,
          col,
          code: dg.code,
          severity: dg.category === ts.DiagnosticCategory.Error ? "error" : "warning",
          message: ts.flattenDiagnosticMessageText(dg.messageText, " "),
        };
      });

    return {
      ok: true,
      errors: diagnostics.filter((d) => d.severity === "error").length,
      warnings: diagnostics.filter((d) => d.severity === "warning").length,
      files: parsed.fileNames.length,
      diagnostics,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

fs.mkdirSync(RUN_ROOT, { recursive: true });

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    return sendJson(res, 200, { ok: true, service: "celld-typescript-check", typescript: ts.version });
  }
  if (req.method !== "POST" || req.url !== "/check") {
    return sendJson(res, 404, { ok: false, error: "unknown route" });
  }

  let body = "";
  let overflow = false;
  req.on("data", (chunk) => {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) {
      overflow = true;
      req.destroy();
    }
  });
  req.on("end", () => {
    if (overflow) return sendJson(res, 413, { ok: false, error: "body too large" });
    let payload;
    try {
      payload = JSON.parse(body);
    } catch (e) {
      return sendJson(res, 400, { ok: false, error: "invalid json" });
    }
    try {
      sendJson(res, 200, runCheck(payload.files || {}, payload.compilerOptions));
    } catch (e) {
      sendJson(res, 500, { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) });
    }
  });
});

// 优雅退出：celld-wake-container 空闲回收时发 SIGTERM。node 作为容器 PID 1 会丢弃
// 未注册 handler 的 SIGTERM，导致 stop 白等 10 秒宽限期后被 SIGKILL（退出码 137，
// 在 NAS 面板上显示成「错误退出」，实为正常回收）。注册后 1 秒内干净退出、码为 0。
for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    console.log("[celld-typescript-check] " + sig + ", shutting down");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}

server.listen(8080, () => {
  console.log("[celld-typescript-check] listening :8080 (typescript " + ts.version + ")");
});
