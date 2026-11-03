"""celld-wake-container：待命容器的唤醒器与按需转发器（常驻 ~25MB 内存）。

职责边界（只做这三件事，不碰业务逻辑，也不碰源码文件）：
- GET  /health  本机健康 + 受管容器当前状态
- POST /check   唤醒 celld-typescript-check，把请求体原样转发给它，回传诊断结果
- 空闲守护      超过 IDLE_SECS 没有 /check 请求，就把受管容器停掉（平时不占内存）

调用方负责准备 files（{相对路径: 源码}）——astrbot 容器已挂载 /vol1/docker/celld，
在调用侧读文件即可，本容器因此不需要挂载任何实例目录。
"""
import docker
import json
import os
import threading
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

IDLE_SECS = int(os.environ.get("CELLD_WAKE_IDLE_SECS", "600"))  # 空闲多久停回待命
START_TIMEOUT = int(os.environ.get("CELLD_WAKE_START_TIMEOUT", "40"))  # 唤醒就绪上限
FORWARD_TIMEOUT = int(os.environ.get("CELLD_WAKE_FORWARD_TIMEOUT", "180"))  # 单次检查上限

# 受管待命容器：容器名 -> 机内服务地址与端口（backend 网桥内按容器名解析）
MANAGED = {
    "celld-typescript-check": "http://celld-typescript-check:8080",
}

cli = docker.from_env()
last_used = [time.time()]


def container_state(name):
    """返回受管容器状态：running / created / exited / missing。"""
    try:
        return cli.containers.get(name).status
    except Exception:
        return "missing"


def wait_ready(base):
    """轮询 /health，直到待命容器真的能接活。"""
    deadline = time.time() + START_TIMEOUT
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(base + "/health", timeout=3) as resp:
                if resp.status == 200:
                    return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def ensure_running(name):
    """按需唤醒：停着就 start，醒着就复用。"""
    state = container_state(name)
    if state == "missing":
        return False, "managed container not found: " + name
    if state != "running":
        cli.containers.get(name).start()
        state = "started"
    if not wait_ready(MANAGED[name]):
        return False, "managed container not ready after start"
    return True, state


def idle_watch():
    """空闲守护：把待命容器重新停回去。"""
    while True:
        time.sleep(30)
        if time.time() - last_used[0] <= IDLE_SECS:
            continue
        for name in MANAGED:
            try:
                c = cli.containers.get(name)
                if c.status == "running":
                    c.stop(timeout=5)
                    print("[wake] idle stop " + name, flush=True)
            except Exception:
                pass


class Handler(BaseHTTPRequestHandler):
    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            return self._json(200, {
                "ok": True,
                "service": "celld-wake-container",
                "managed": {name: container_state(name) for name in MANAGED},
            })
        self._json(404, {"ok": False, "error": "unknown route"})

    def do_POST(self):
        if self.path != "/check":
            return self._json(404, {"ok": False, "error": "unknown route"})
        last_used[0] = time.time()
        name = next(iter(MANAGED))
        try:
            n = int(self.headers.get("content-length", 0))
            raw = self.rfile.read(n) if n else b"{}"
            ok, detail = ensure_running(name)
            if not ok:
                return self._json(503, {"ok": False, "error": detail})
            req = urllib.request.Request(
                MANAGED[name] + "/check", data=raw,
                headers={"content-type": "application/json"}, method="POST")
            try:
                with urllib.request.urlopen(req, timeout=FORWARD_TIMEOUT) as resp:
                    payload = resp.read()
                    self.send_response(resp.status)
                    self.send_header("content-type", "application/json; charset=utf-8")
                    self.send_header("content-length", str(len(payload)))
                    self.end_headers()
                    self.wfile.write(payload)
                    return
            except urllib.error.HTTPError as e:
                return self._json(e.code, {"ok": False, "error": e.read().decode("utf-8", "ignore")[:300]})
        except Exception as e:
            return self._json(500, {"ok": False, "error": str(e)[:300]})

    def log_message(self, *args):
        pass


threading.Thread(target=idle_watch, daemon=True).start()
print("[wake] listening :8081, managed=" + ",".join(MANAGED), flush=True)
ThreadingHTTPServer(("0.0.0.0", 8081), Handler).serve_forever()
