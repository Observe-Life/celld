#!/usr/bin/env python3
# systemd socket 激活中继：fd3 接收连接 → 确保 celld-ts-check 运行 → 双向转发；空闲自动停容器
import socket, subprocess, threading, time, os

CONTAINER = "celld-ts-check"; IP = "172.23.0.250"; PORT = 8080
IDLE_STOP = 600
last_active = time.time()

def wake():
    subprocess.run(["docker", "start", CONTAINER], capture_output=True)
    for _ in range(60):
        try:
            s = socket.create_connection((IP, PORT), 1); s.close(); return True
        except OSError: time.sleep(0.5)
    return False

def pump(a, b):
    try:
        while True:
            d = a.recv(65536)
            if not d: break
            b.sendall(d)
    except OSError: pass
    try: b.shutdown(socket.SHUT_WR)
    except OSError: pass

def idle_watch():
    global last_active
    while True:
        time.sleep(30)
        if time.time() - last_active > IDLE_STOP:
            subprocess.run(["docker", "stop", CONTAINER], capture_output=True)
            os._exit(0)  # 退出 → systemd socket 重新监听，下个连接再唤醒

threading.Thread(target=idle_watch, daemon=True).start()
lf = socket.socket(fileno=3)  # systemd socket activation 传入的监听 fd
lf.listen(128)
print("[relay] listening", flush=True)
while True:
    a, _ = lf.accept()
    last_active = time.time()
    if not wake():
        a.close(); continue
    last_active = time.time()
    try:
        b = socket.create_connection((IP, PORT), 5)
    except OSError:
        a.close(); continue
    threading.Thread(target=pump, args=(a, b), daemon=True).start()
    threading.Thread(target=pump, args=(b, a), daemon=True).start()
