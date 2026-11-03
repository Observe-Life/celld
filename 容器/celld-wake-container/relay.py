"""celld 唤醒器与按需编排器：
- /health：健康检查
- /check {instance_dir}：按需拉起一次性 tsc 容器跑类型检查（L0 由部署闸门承担）
- 闲置自动停止受管容器（celld-typescript-check 等）
"""
import docker, socket, threading, time, json, os

cli = docker.from_env()
MANAGED = ["celld-typescript-check"]
IDLE = 600
last = [time.time()]
TSC_IMAGE = "ghcr.io/observe-life/node-tsc:latest"

def wake(name):
    try:
        c = cli.containers.get(name)
        if c.status != "running":
            c.start()
        return True
    except Exception:
        return False

def run_typecheck(instance_dir):
    src = instance_dir.rstrip("/") + "/kb-sync"
    tsconfig = {
        "compilerOptions": {
            "strict": True, "noEmit": True, "target": "ES2022",
            "module": "ESNext", "moduleResolution": "Bundler",
            "lib": ["ES2022", "WebWorker"], "skipLibCheck": True,
            "noUncheckedIndexedAccess": True, "exactOptionalPropertyTypes": True,
            "noImplicitReturns": True,
            "types": [], "typeRoots": ["/usr/local/lib/node_modules/@cloudflare/workers-types"],
        },
        "include": ["/src/**/*.ts"],
    }
    cmd = "node -e " + json.dumps(
        "const fs=require(fs);fs.writeFileSync(/tmp/t.json,process.env.TSCONFIG)") + \
        " && npx tsc -p /tmp/t.json --pretty false"
    out = cli.containers.run(
        TSC_IMAGE, ["sh", "-c", cmd],
        environment={"TSCONFIG": json.dumps(tsconfig)},
        volumes={src: {"bind": "/src", "mode": "ro"}},
        remove=True, stderr=True,
    )
    return out.decode("utf-8", "ignore") if isinstance(out, bytes) else str(out)

def idle_watch():
    while True:
        time.sleep(30)
        if time.time() - last[0] > IDLE:
            for name in MANAGED:
                try:
                    c = cli.containers.get(name)
                    if c.status == "running":
                        c.stop(timeout=5)
                except Exception:
                    pass

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
        if not wake(MANAGED[0]): a.close(); continue
        last[0] = time.time()
        b = socket.create_connection(("celld-typescript-check", 8080), 5)
        threading.Thread(target=pump, args=(a, b), daemon=True).start()
        threading.Thread(target=pump, args=(b, a), daemon=True).start()
    except OSError as e:
        print("[wake] conn error:", e, flush=True)
