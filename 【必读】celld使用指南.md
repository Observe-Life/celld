# 【必读】celld 使用指南（多 worker 单容器实践）

> 本文记录我们在单机部署 celld 时，围绕官方模型的几条硬限制所做的架构设计与操作纪律。
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
celld（唯一容器 = 唯一舰队）
├── scheduler      ← 常驻根：持有全部 cron 表达式 + 总入口转发（/kb/*、/mm/*）
├── kb-sync        ← 会话同步（队列消费者 + 幂等短路），不感知时间
└── multimedia     ← 多媒体转写（Workflows），不感知时间
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
1. 新建 `apps/实例/<name>/`，`wrangler.jsonc` 里对**每个现存 worker**加 `services` 绑定；
2. 反向：给每个现存 worker 的模板加上对 `<name>` 的绑定；
3. 需要定时的话：在 scheduler 的 `triggers.crons` 加表达式 + `SCHEDULES` 加路由；
4. 跑 `apps/实例/deploy.sh`（自动含重启）。

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
2. **epoch GC 常开**：容器环境 `CELLD_LTX_RETENTION_SECS=604800`（防限制 2/失败循环造成的桶侧堆积）；本地 `state/` 目录若再出现成百上千 epoch，说明又进了失败启动循环，先停循环（恢复闭包完整）再清残骸；
3. **处理预算**：`CELLD_HANDLER_BUDGET_S=900`（长转写/等解析别被默认 300s 掐死）；
4. **大表批量删除前先建索引或按主键点名**（与 celld 无关，但我们在同一台 NAS 上吃过全表扫描的亏：4GB 库机械盘 1 小时 0 写入）。

## 五、与 Cloudflare 的差异（为什么需要这份指南）

Cloudflare 账号级平台天然支持“N 个独立 worker 各自部署、各自定时、互不干扰”；celld 的定位是“**一个舰队跑一个应用**”（README L214），没有账号级多应用调度。本架构用“互绑闭包 + 中央调度器 + 部署重启”在**单容器内**重建了 CF 的使用体验：worker 数量增长不增加容器，定时规则增长只改一张表。

---
*最后更新：2026-11-01。改动 celld 部署结构前请先阅读本文并对照源码行号复核（上游版本迭代可能改变行为）。*
