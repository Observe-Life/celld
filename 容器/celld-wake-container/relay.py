"""celld 唤醒器：监听 8081，按需唤醒 celld-typescript-check 并转发；空闲自动停容器。"""
import docker, socket, threading, time

cli = docker.from_env()
CONTAINER = "celld-typescript-check"
TARGET = ("celld-typescript-check", 8080)
IDLE = 600
last = [time.time()]

def wake():
    try:
        c = cli.containers.get(CONTAINER)
        if c.status != "running":
            c.start()
    except Exception:
        return False
    for _ in range(60):
        try:
            s = socket.create_connection(TARGET, 1); s.close(); return True
        except OSError:
            time.sleep(0.5)
    return False

def idle_watch():
    while True:
        time.sleep(30)
        if time.time() - last[0] > IDLE:
            try: cli.containers.get(CONTAINER).stop()
            except Exception: pass

def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    try: b.shutdown(socket.SHUT_WR)
    except OSError: pass

lf = socket.socket(); lf.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
lf.bind(("0.0.0.0", 8081)); lf.listen(128)
print("[wake] listening :8081", flush=True)
threading.Thread(target=idle_watch, daemon=True).start()
while True:
    a, _ = lf.accept()
    last[0] = time.time()
    try:
        if not wake(): a.close(); continue
        last[0] = time.time()
        b = socket.create_connection(TARGET, 5)
        threading.Thread(target=pump, args=(a, b), daemon=True).start()
        threading.Thread(target=pump, args=(b, a), daemon=True).start()
    except OSError as e:
        print("[wake] conn error:", e, flush=True)
