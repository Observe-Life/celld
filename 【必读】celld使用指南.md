# 【必读】celld 使用指南

## 〇、使用 celld 的基本框架（2026-11-03 起，**以本节为准**）

* **一个 celld 实例**：由一个或多个 celld 功能模块组成
* **一个 celld 容器**：由一个或一组互相关联的 celld 实例组成（上游英文文档称 fleet，本框架统一叫**容器**）
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
| `celld` | 活跃 | 177MiB | 装着 scheduler + multimedia 两个实例（会话同步已拆出） |
| `celld-agent-to-rag` | 活跃 | 约 180MiB | 智能体会话导入知识库；Workflow 形态，自带 cron |
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
| 1 | **一个容器同一时刻只跑一个“应用根”**：每次 `celld deploy` 都会无条件改写全局指针 `deploy/current.json`，谁最后部署谁当根 | `crates/celld/deploy.rs` L937-946（注释原文：“the fleet-wide one is the sole application selector”；上游英文文档里的 fleet，本框架统一称**容器**） |
| 2 | **cron 定时只有“根”会触发**；被 service 绑定带进来的 cohosted worker，其 cron 永不触发（只警告不报错） | `crates/celld/generation.rs` L210-228（注释原文：“a node fires only its own deployment's schedule… Deploy the script as a node's own deployment to run its crons”） |
| 3 | **组件（cohosted worker）单独更新不会自动生效**：节点只在根指针变化时重走依赖闭包；组件指针变了但根没变时，运行中的仍是旧 bundle | 实测复现；`crates/celld/main.rs` `start_pointer_watcher` 以全局指针为触发源 |
| 4 | **队列 sendBatch 单次上限 100 条**，超出直接报错 `QUEUE_ERROR: a batch has at most 100 messages` | `crates/logic/queue.rs` 及运行时校验 |

另有一个上游已知缺陷会放大以上问题：**失败的 DO 启动会泄漏已恢复的 SQLite epoch 并热循环**（celld issue #276）。我们曾因此让一个 cell 攒出 1,566 个 epoch / 258MB 磁盘残骸 + ~600MB 泄漏内存。

## 二、我们的解法：单容器多 worker 架构

```
celld（活跃容器）
├── scheduler              ← 本容器的根：cron 表 + 前门转发（/mm/*）
└── multimedia-pipeline    ← 多媒体转写（Workflows）

celld-agent-to-rag（另一个活跃容器，桶 s3://celld-rag）
└── celld-agent-to-rag     ← 自己就是本容器的根：自带 cron + Workflow 会话同步

celld-typescript-check（待命容器）+ celld-wake-container（活跃唤醒入口）

注：「一个容器只跑一个应用根」这条限制没变（限制 1）；变的是整机有多个 celld 容器。
    跨容器**没有** service 绑定（celld 的 services 只在同一容器内有效），
    容器之间要互访只能走「容器名:机内端口」的 HTTP。
```

三条设计原则：

1. **互相 service 绑定**（~~原纪律~~ → **2026-11-03 作废**）：当时要求每个 worker 都声明对其余 worker 的 `services` 绑定，
   目的是让依赖闭包里永远有全部 worker，避免「孤儿 cell 启动失败循环」。
   **实测推翻了它的前提**：全量 grep `env.*` 使用计数后确认，`kb-sync` 从未调用过 `MM`/`SCHEDULER`，
   `multimedia` 从未调用过 `KBSYNC`——这些绑定是纯声明、零调用，只为满足纪律而存在。
   现在只在**真正会调用**的实例之间保留绑定（scheduler ↔ multimedia），跨容器一律不声明 service 绑定。
2. **调度彻底解耦**：所有周期任务集中在 scheduler 的一张路由表：
   ```ts
   const SCHEDULES: Record<string, Route> = {
     "37 * * * *": { service: "KBSYNC", path: "/run", method: "POST" },
     // "0 7 * * *": { service: "MM", path: "/daily-job" },
   };
   ```
   加一种定时 = 加一行表达式 + 一行路由，**worker 代码零改动**。cron 最小粒度 1 分钟（与 Cloudflare 相同）；秒级需求走 DO alarms 或队列延时，不要塞进 cron。
3. **部署即重启**：`deploy.sh` 在部署完所有组件后执行 `docker restart celld`（约 20 秒，状态在桶里，无损），绕开限制 3。

### celld-agent-to-rag：会话导入知识库（Workflow 形态）

从 `celld` 容器拆出的独立活跃容器，桶 `s3://celld-rag`，自己就是本容器的根（cron 直接写在它身上）。

执行模型的关键选择：

- **一个会话一个 Workflow 实例**，实例号 = `uuid-版本`（版本取自 `updated_at`）。
  同版本重复触发由平台静默去重（`createBatch()` 对已存在实例号返回 `created:false`），
  因此**不需要 KV 锁**——旧实现用 KV 时间戳锁，且拿不到锁就 `message.ack()` 丢弃消息，存在静默丢数据路径。
- **等解析用 `step.sleep` + 短查询步骤**，而不是在 handler 里同步轮询 600 秒。
  等待期间实例休眠、不占 isolate（celld 文档原话），所以并发不再被 isolate 卡死。
- **转写步骤结果持久化**：重放或重试都不会再烧一次 JBB 转写费。
- **每轮最多创建 2 个实例**（`SYNC_CONCURRENCY`，用户定的保守值，≈旧 `max_concurrency=2` 的吞吐）。
- 步骤结果/入参各 ≤1MiB，所以 raw 与 md 本体一律留在 R2、步骤只回摘要与哈希。
- 已知平台差异：`status()` 只返回 `{status, rollback}`，**没有 steps 数组**；终态字符串是 `complete`（不是 `completed`）。

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
| `POST /run`（在 `celld-agent-to-rag:8080`） | 会话同步立即对账一轮；`GET /status?uuid=` 查 Workflow 实例进度 |
| `GET /kb/*`（在 `celld:8080`） | **已退役**，返回 404 并提示新地址 |
| `GET /mm/health`、`POST /mm/run`、`POST /mm/status` | 多媒体转写 |

### 队列投递（写 worker 代码时）
`sendBatch` 必须按 ≤100 条分片：
```ts
for (let i = 0; i < uuids.length; i += 100) {
  await env.QUEUE.sendBatch(uuids.slice(i, i + 100).map((uuid) => ({ body: { uuid } })));
}
```

## 四、必须保持的纪律（防事故）

1. **带 cron 的实例必须是它所在容器的根**（限制 2）：`celld` 容器的根是 scheduler，`celld-agent-to-rag` 容器的根是它自己；
   每个容器的部署脚本都把本容器的根放在最后部署；
2. **epoch GC 常开**：容器环境 `CELLD_LTX_RETENTION_SECS=604800`（防限制 2/失败循环造成的桶侧堆积）；本地 `data/state/` 目录若再出现成百上千 epoch（该目录已从 `state/` 更名为 `data/`），说明又进了失败启动循环，先停循环（恢复闭包完整）再清残骸；
3. **处理预算**：`CELLD_HANDLER_BUDGET_S=900`（长转写/等解析别被默认 300s 掐死）；
4. **大表批量删除前先建索引或按主键点名**（与 celld 无关，但我们在同一台 NAS 上吃过全表扫描的亏：4GB 库机械盘 1 小时 0 写入）。

## 五、与 Cloudflare 的差异（为什么需要这份指南）

Cloudflare 账号级平台天然支持“N 个独立 worker 各自部署、各自定时、互不干扰”；celld 的定位是“**一个容器只跑一个应用**”（README L214），没有账号级多应用调度。该架构用“互绑闭包 + 中央调度器 + 部署重启”在**单个 celld 容器内**重建了 CF 的使用体验：worker 数量增长不增加容器，定时规则增长只改一张表。2026-11-03 起再叠加一层：低频能力（如类型检查）不进 celld 容器，改为独立的待命容器 + 活跃唤醒容器，见顶部框架节。

---
*最后更新：2026-11-03（顶部新增实例/容器/活跃/待命框架与待命容器标准做法；旧版内容就地校正路径与容器拓扑）。改动 celld 部署结构前请先阅读本文并对照源码行号复核（上游版本迭代可能改变行为）。*
