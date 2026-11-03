# 【必读】celld 使用指南

## 〇、使用 celld 的基本框架（2026-11-03 起，**以本节为准**）

* **一个 celld 实例**：由一个或多个 celld 功能模块组成
* **一个 celld 容器**：由一个或多个互相关联的 celld 实例组成
* **celld 容器的分类**
  1. **活跃容器**：高频使用；持续占用一定的算力、内存
  2. **待命容器**：低频使用；按需唤醒、闲置自停，暂停时容器仍在「正在运行的容器列表」，但只占用极少的算力、内存
* **celld 容器的命名规范**：`celld-XXX-XXX`（celld 后面跟的字段为 2～3 节）
* **所有实例源码的存放文件夹**：`/vol1/docker/celld/实例/`
* **所有实例容器镜像源码的存放文件夹**：`/vol1/docker/celld/实例容器镜像源码/`

### compose 规范

- **所有 celld 相关的容器，一律放进同一个 compose**：`/vol1/docker/celld/compose.yaml`。
  它包含：celld 主容器、存储后端（minio / minio-init）、以及全部待命容器与唤醒容器。
- **理由**：一个 compose 项目就是「这套东西都属于 celld」的边界。NAS 面板里它们归在同一个应用条目（项目名 `celld`）下，
  一眼能看清归属与整体资源占用；启停、备份、容灾整体迁移也以这个 compose 为单位。
- **禁止**为某个待命/辅助能力另开独立 compose，或用裸 `docker run` 长期常驻——那会让归属关系散失，
  清理工具与运维者都无法判断这些容器是一体的。
- 容器之间一律「容器名:机内端口」；**不得**为容器间调用开宿主端口映射（详见下面「待命容器的标准做法」）。

---

### 待命容器的标准做法：空壳常驻 + 按需 exec

低频能力的容器一律按这个形态建，**不要**给待命容器装 HTTP 服务、再用 start/stop 去编排它：

1. **容器本身常驻运行**：PID 1 是一个 `sleep` 空壳（`CMD ["sh","-c","while :; do sleep 3600; done"]`），实测只占约 900KiB。于是它始终出现在「正在运行的容器列表」里，镜像被活跃容器引用，不会被清理工具判定成没在用的垃圾镜像。
2. **真正吃资源的进程按需拉起、用完即走**：由唤醒方在容器内 `docker exec` 跑工作进程，跑完进程就消失，容器不受影响。
3. **工作进程只走 stdin/stdout，不监听端口**：所以待命容器不需要任何网络地址，也不会有端口冲突。
4. **唤醒方是活跃容器**，持有 `docker.sock`，只承担「唯一入口 + 权限隔离」：调用方既不需要 docker 权限，也不需要知道待命容器的地址。
5. 采用这个形态就**连带删掉三套机制**：就绪轮询、空闲看门狗、SIGTERM 优雅退出。后三者是 start/stop 形态的产物——尤其缺了 SIGTERM 时，`docker stop` 会白等满宽限期再被 SIGKILL，退出码 137 在 NAS 面板显示成「错误退出」，把正常回收误报成故障。

当前归类（实测占用）：

| 容器 | 归类 | 占用 | 说明 |
|---|---|---|---|
| `celld` | 活跃 | 177MiB | 装着 scheduler + kb-sync + multimedia 三个实例 |
| `celld-wake-container` | 活跃 | 22.65MiB | 待命容器的唯一唤醒入口，挂 `docker.sock` |
| `celld-typescript-check` | 待命 | 空壳 916KiB | 类型检查；node 进程仅在检查的 1-2 秒内存在 |

---

> 以下内容的**技术结论仍然有效**（源码取证的硬限制：单应用根、cron 仅根触发、组件更新需重启、
> sendBatch ≤100，以及第四节的操作纪律），路径与容器拓扑已按 2026-11-03 的新框架就地校正。

## 附：celld 多 worker 单容器实践（历史沿革，路径与拓扑已校正）

> 记录我们在单机部署 celld 时，围绕官方模型的几条硬限制所做的架构设计与操作纪律。
> 官方文档没有集中写这些，全部结论来自源码取证（文中注明文件与行号）。动 celld 之前先读这份。

## 一、官方模型的四条硬限制（源码取证）

| # | 限制 | 出处 |
|---|---|---|
| 1 | **一个舰队（fleet）同一时刻只跑一个“应用根”**：每次 `celld deploy` 都会无条件改写全局指针 `deploy/current.json`，谁最后部署谁当根 | `crates/celld/deploy.rs` L937-946（注释原文：“the fleet-wide one is the sole application selector”） |
| 2 | **cron 定时只有“根”会触发**；被 service 绑定带进来的 cohosted worker，其 cron 永不触发（只警告不报错） | `crates/celld/generation.rs` L210-228（注释原文：“a node fires only its own deployment's schedule… Deploy the script as a node's own deployment to run its crons”） |
| 3 | **组件（cohosted worker）单独更新不会自动生效**：节点只在根指针变化时重走依赖闭包；组件指针变了但根没变时，运行中的仍是旧 bundle | 实测复现；`crates/celld/main.rs` `start_pointer_watcher` 以全局指针为触发源 |
| 4 | **队列 sendBatch 单次上限 100 条**，超出直接报错 `QUEUE_ERROR: a batch has at most 100 messages` | `crates/logic/queue.rs` 及运行时校验 |

另有一个上游已知缺陷会放大以上问题：**失败的 DO 启动会泄漏已恢复的 SQLite epoch 并热循环**（celld issue #276）。我们曾因此让一个 cell 攒出 1,566 个 epoch / 258MB 磁盘残骸 + ~600MB 泄漏内存。

## 二、我们的解法：单容器多 worker 架构

```
celld（一个活跃容器 = 一个舰队，内含三个实例）
├── scheduler      ← 常驻根：持有全部 cron 表达式 + 总入口转发（/kb/*、/mm/*）
├── kb-sync        ← 会话同步（队列消费者 + 幂等短路），不感知时间
└── multimedia     ← 多媒体转写（Workflows），不感知时间

注：「一个容器 = 一个舰队」仍然成立（限制 1 未变）；变的是**整机不再只有一个 celld 容器**——
    待命能力（如类型检查）放在独立容器里，见上面「待命容器的标准做法」。
```

三条设计原则：

1. **互相 service 绑定**：每个 worker 的 `wrangler.jsonc` 都声明对其余 worker 的 `services` 绑定。
   依赖遍历有环保护（generation.rs 的 visited 集合），因此**无论谁当根，闭包里永远有全部 worker**，不存在“孤儿 cell 启动失败循环”。
2. **调度彻底解耦**：所有周期任务集中在 scheduler 的一张路由表：
   ```ts
   const SCHEDULES: Record<string, Route> = {
     "37 * * * *": { service: "KBSYNC", path: "/run", method: "POST" },
     // "0 7 * * *": { service: "MM", path: "/daily-job" },
   };
   ```
   加一种定时 = 加一行表达式 + 一行路由，**worker 代码零改动**。cron 最小粒度 1 分钟（与 Cloudflare 相同）；秒级需求走 DO alarms 或队列延时，不要塞进 cron。
3. **部署即重启**：`deploy.sh` 在部署完所有组件后执行 `docker restart celld`（约 20 秒，状态在桶里，无损），绕开限制 3。

## 三、操作手册

### 加一个新 worker（第 4、第 100 个都一样）
1. 新建 `/vol1/docker/celld/实例/<name>/`，`wrangler.jsonc` 里对**每个现存 worker**加 `services` 绑定；
2. 反向：给每个现存 worker 的模板加上对 `<name>` 的绑定；
3. 需要定时的话：在 scheduler 的 `triggers.crons` 加表达式 + `SCHEDULES` 加路由；
4. 跑 `/vol1/docker/celld/实例/deploy.sh`（自动含闸门与重启）。

### 常用端点（经 scheduler 前门）
| 端点 | 用途 |
|---|---|
| `GET /health` | scheduler 自身与已注册调度表 |
| `POST /fire {"cron":"..."}` | 手动触发一条调度（验证派发链） |
| `POST /kb/run` | 会话同步立即对账一轮 |
| `GET /mm/health`、`POST /mm/run`、`POST /mm/status` | 多媒体转写 |

### 队列投递（写 worker 代码时）
`sendBatch` 必须按 ≤100 条分片：
```ts
for (let i = 0; i < uuids.length; i += 100) {
  await env.QUEUE.sendBatch(uuids.slice(i, i + 100).map((uuid) => ({ body: { uuid } })));
}
```

## 四、必须保持的纪律（防事故）

1. **不要让带 cron 的 worker 当“最后部署者”以外的角色**——根永远是 scheduler（部署脚本已保证 scheduler 最后部署）；
2. **epoch GC 常开**：容器环境 `CELLD_LTX_RETENTION_SECS=604800`（防限制 2/失败循环造成的桶侧堆积）；本地 `data/state/` 目录若再出现成百上千 epoch（该目录已从 `state/` 更名为 `data/`），说明又进了失败启动循环，先停循环（恢复闭包完整）再清残骸；
3. **处理预算**：`CELLD_HANDLER_BUDGET_S=900`（长转写/等解析别被默认 300s 掐死）；
4. **大表批量删除前先建索引或按主键点名**（与 celld 无关，但我们在同一台 NAS 上吃过全表扫描的亏：4GB 库机械盘 1 小时 0 写入）。

## 五、与 Cloudflare 的差异（为什么需要这份指南）

Cloudflare 账号级平台天然支持“N 个独立 worker 各自部署、各自定时、互不干扰”；celld 的定位是“**一个舰队跑一个应用**”（README L214），没有账号级多应用调度。该架构用“互绑闭包 + 中央调度器 + 部署重启”在**单个 celld 容器内**重建了 CF 的使用体验：worker 数量增长不增加容器，定时规则增长只改一张表。2026-11-03 起再叠加一层：低频能力（如类型检查）不进 celld 容器，改为独立的待命容器 + 活跃唤醒容器，见顶部框架节。

---
*最后更新：2026-11-03（顶部新增实例/容器/活跃/待命框架与待命容器标准做法；旧版内容就地校正路径与容器拓扑）。改动 celld 部署结构前请先阅读本文并对照源码行号复核（上游版本迭代可能改变行为）。*
