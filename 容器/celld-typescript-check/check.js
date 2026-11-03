// celld-typescript-check 的工作进程：stdin 收 {files:{路径:源码}, compilerOptions?} → stdout 出诊断 JSON
//
// 形态说明（重要）：本容器**常驻运行**（PID 1 是一个 840KiB 的 sleep 空壳，见 Dockerfile），
// 但这个 node 进程只在被调用时由 celld-wake-container 用 docker exec 拉起、跑完即退出。
// 于是同时满足两件事：容器始终在「正运行列表」里（镜像被活跃容器引用，不会被清理软件当垃圾），
// 而真正吃内存的 node+typescript 只在干活的几秒内存在。
//
// 检查口径：源码落到 /app/run/<请求id>/ 真实目录，用 TypeScript 标准 CompilerHost（ts.sys）
// 从磁盘解析 lib 与 node_modules —— 与 `tsc -p` 同一条路径，不手写任何 lib 映射。
const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const RUN_ROOT = "/app/run";

// 与实例 tsconfig.json 同口径（gates/typecheck.sh 的判据依赖它，不得漂移）
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
    const host = ts.createCompilerHost(parsed.options, true);
    const program = ts.createProgram({ rootNames: parsed.fileNames, options: parsed.options, host });

    const prefix = dir + path.sep;
    const diagnostics = ts.getPreEmitDiagnostics(program).map((dg) => {
      const fileName = dg.file ? dg.file.fileName.replace(prefix, "") : "(program)";
      let line = 1, col = 1;
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
      typescript: ts.version,
      diagnostics,
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

fs.mkdirSync(RUN_ROOT, { recursive: true });

let raw = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => { raw += c; });
process.stdin.on("end", () => {
  let out;
  try {
    const payload = JSON.parse(raw);
    out = runCheck(payload.files || {}, payload.compilerOptions);
  } catch (e) {
    out = { ok: false, error: String(e && e.message ? e.message : e).slice(0, 300) };
  }
  process.stdout.write(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
});
