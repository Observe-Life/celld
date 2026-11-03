"""celld-wake-container：类型检查的唯一入口 + 权限隔离层（常驻 ~22MiB）。

- GET  /health   自检，并报告待命容器状态
- POST /check    在常驻的 celld-typescript-check 容器里 exec 一个 node 工作进程，
                 stdin 送 {files, compilerOptions?}，stdout 收诊断 JSON，跑完即退出

为什么是这个形态：
- 待命容器**常驻运行**（空壳 840KiB），所以它一直出现在「正运行列表」里，镜像被活跃容器引用，
  不会被清理工具判定为无用镜像；而 node+typescript 只在干活的几秒内存在。
- 调用方不需要 docker 权限，也不需要知道待命容器的机内地址：一律只认 `celld-wake-container:8081`。
- 不再需要 start/stop/就绪轮询/空闲看门狗——少一套机制就少一类故障（旧版靠 SIGTERM 优雅退出
  才把「被强杀的 137」和「真故障」区分开，现在根本没有停止动作了）。
"""
import docker
import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

STANDBY = os.environ.get("CELLD_WAKE_STANDBY", "celld-typescript-check")
CHECK_TIMEOUT = os.environ.get("CELLD_WAKE_CHECK_TIMEOUT", "180")
WORK_CMD = ["timeout", CHECK_TIMEOUT, "node", "/app/check.js"]

cli = docker.from_env()


def standby_state():
    try:
        return cli.containers.get(STANDBY).status
    except Exception:
        return "missing"


def run_check(raw):
    """在待命容器内跑一次检查；返回 (http_status, 响应字节)。"""
    c = cli.containers.get(STANDBY)
    if c.status != "running":
        c.start()
        c.reload()
        if c.status != "running":
            return 503, json.dumps({"ok": False, "error": "standby container not running"}).encode()
    res = c.exec_run(WORK_CMD, stdin_data=raw, demux=False)
    out = res.output if isinstance(res.output, (bytes, bytearray)) else str(res.output).encode()
    return (200 if res.exit_code == 0 else 500), out


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, payload):
        if isinstance(payload, str):
            payload = payload.encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        if self.path == "/health":
            return self._send(200, json.dumps({
                "ok": True,
                "service": "celld-wake-container",
                "standby": {STANDBY: standby_state()},
            }))
        self._send(404, json.dumps({"ok": False, "error": "unknown route"}))

    def do_POST(self):
        if self.path != "/check":
            return self._send(404, json.dumps({"ok": False, "error": "unknown route"}))
        try:
            n = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(n) if n else b"{}"
            code, payload = run_check(raw)
            return self._send(code, payload)
        except Exception as e:
            return self._send(500, json.dumps({"ok": False, "error": str(e)[:300]}))

    def log_message(self, *args):
        pass


print("[wake] listening :8081, standby=" + STANDBY, flush=True)
ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
