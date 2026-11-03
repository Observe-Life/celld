# 【计划】celld-agent-to-rag：拆分独立容器 + Workflow 化

> 状态：已批准实施（2026-11-03 用户指令：「你自己思考完，直接实施」）。
> 依据：`【必读】celld使用指南.md` 顶部框架节（实例/容器/活跃/待命、命名规范、compose 规范）。

## 一、已批准的范围与依据

**目标**：把「智能体会话导入知识库」能力从 `celld` 主容器拆出，成为独立**活跃容器** `celld-agent-to-rag`（实例同名），执行模型从「队列 handler 同步轮询 + KV 锁」改为 **Workflows**。

**用户已定的决策**（不再讨论）：

| 项 | 决定 |
|---|---|
| 数据隔离档位 | **B**：新建独立桶 `celld-rag`，沿用同一 minio 凭据 |
| 初始数据来源 | **C**：`mc mirror` 底层复制 + 插件水位对账自动兜底 |
| 并发上限 | **每轮 2 个**实例（≈现状吞吐，做成可配变量） |
| 主容器改名 | **不改**，后续用户会继续把别的实例拆出去 |
| 实施授权 | 直接实施，无需逐步请示 |

**非目标**：不改业务语义（审批闸门、下架、镜像双写、自愈放行全部保留）；不动 multimedia；不引入新外部依赖；不装新软件包。

## 二、调研得到的关键事实（设计的地基）

1. **实例间零业务互调**（全量 grep `env.*` 使用计数）：kb-sync 只用 STATE(27)/FILES(9)/QUEUE(4)，`MM`、`SCHEDULER` **零调用**；multimedia 只用 PIPELINE(2)，`KBSYNC` **零调用**；只有 scheduler 真的调用两者。→ 旧文档「互绑闭包」纪律是死绑定，本次作废。
2. **celld 支持 bucket 前缀**（`crates/celld/bucket.rs` L268-295），但官方 `docs/limitations.md` 明确「一个舰队跑一个应用」「fleet bucket 控制整个舰队」。→ 拆分 = 新舰队 = 新桶。
3. **Workflows 能力**（`docs/services/workflows.md`）：等待期间 `A waiting instance holds no isolate`；并发实例数不设上限；step 结果持久化、失败只重跑该步；deadline 崩溃不移动。**硬限制**：非步骤代码挂起 ≤60s；步骤结果/入参/事件各 ≤1MiB；retention ≤30d；无 REST API（只能经 binding 驱动）。
4. **当前瓶颈是设计性的**：`waitParse` 每 5 秒轮询、最长 600 秒，全程占着 isolate，`max_concurrency=2` 因此成为硬上限（≈12 篇/小时）。
5. **当前形态没有故障**（近 6 小时实测：`done` 14 次、`lock skip` 0 次、无预算超限、无死信）→ 本次是执行模型纠偏，不是救火。
6. **插件是水位对账式**（`state.json` 的 `pushed[uuid]=updated_at`，异常不推进水位）→ 切流与短暂失败都不丢数据。
7. **迁移规模实测**：212 篇 md、212 个 raw 会话、R2 310M、KV 台账 cell 17M（14 epoch）。

## 三、Change Necessity

- 用户可见需要：知识库导入要能独立存活/重启/容灾，且批量导入不再被「等待占 isolate」卡死吞吐。
- 不改代码行不行：不行。容器边界与执行模型都是代码+配置层面的结构，配置改不出 workflow 语义。
- 最小代码边界：新建 `实例/celld-agent-to-rag/`（wrangler 模板 + `src/` 的 workflow 版实现 + acceptance + deploy）；主容器侧只删 kb-sync 实例与死绑定；插件只改 `worker_url` 一行。
- Decision: **code-change**

## 四、Ripple Signal Triage

| 信号 | 命中 | 处置 |
|---|---|---|
| persistence / source-of-truth | ✅ 新桶、KV 台账与 R2 迁移 | canonical owner = 新舰队；旧桶旧容器**保留不动**作回滚位 |
| contract | ✅ 实例入口从 scheduler 前门 `/kb/*` 变为直接根路径 | 插件 `worker_url` 是唯一消费者，实测确认只此一处 |
| retirement | ✅ 队列、KV 锁、互绑闭包纪律 | delete-first（内部代码），见第八节 |
| duplicate owner | ✅ 队列与 workflow 都提供重试/状态 | 去掉队列，workflow 单一 owner |
| 跨模块 | ✅ scheduler 失去 KBSYNC | 主容器需重新部署（20 秒重启），排在切流验证之后 |

## 五、TDD Route

`mode=off`（Aegis 配置）→ **skipped**，无 strict 授权。验证改为「诊断复现 + 变更后回归」：
- 迁移前记录 212 篇清单与台账指纹，迁移后逐项比对；
- 新会话走通全链（转写→上传→解析→台账）作为目标证据；
- **重启续跑必须实测**（kill 容器后实例从已完成步骤续跑），不接受推断。

## 六、任务分解

| # | 任务 | 完成判据 | 风险 |
|---|---|---|---|
| T1 | 新桶 `celld-rag` + compose 新服务（独立 state 目录 `/vol1/docker/celld-agent-to-rag/data`） | `docker compose config` 通过；新容器起来 `/health` 200；不影响现网 | 低 |
| T2 | 实例骨架：`wrangler.template.jsonc`（workflows 绑定、无 queues、无 services）、`env.ts`、`tsconfig.json`、`acceptance.json`、`deploy.sh`、`secrets.json` | L0 预检通过 | 低 |
| T3 | **Workflow 化实现**：`WorkflowEntrypoint` 类；步骤切分 loadRaw / 转写 / saveMd / 删旧档 / 上传 / 查解析 / 写台账；等待拆成 `step.sleep` + 短轮询步骤（严禁非步骤挂起 >60s）；只传 uuid 不传字节；去队列、去 KV 锁；`/run` 每轮 `create` ≤2 个实例 | L1 类型检查 0 错；bundle 成功 | **高**（重放纯净是主要风险点） |
| T4 | 小样迁移验证：复制 1 个会话的 R2 + KV cell → 新容器读出台账与文件 | 能读出且哈希/own.json 不阻碍认领 | 中 |
| T5 | 全量 `mc mirror` + 新容器接管 | 212 篇 `/files` 清单与旧容器逐项一致 | 中 |
| T6 | 新容器上跑通 workflow 全链 + **重启续跑实测** | 新会话入库成功；重启后从已完成步骤续跑、不重复烧转写 | 中 |
| T7 | 切流：插件 `worker_url` → `http://celld-agent-to-rag:8080` | 一轮对账无异常、无积压 | 低（回滚=改回） |
| T8 | 主容器移除 kb-sync：`deploy.sh`、scheduler 的 `KBSYNC`、multimedia 的 `KBSYNC` 死绑定 | 主容器三→两实例，cron 正常，L0 闭包检查通过 | 中（需重启节点） |
| T9 | 文档与纪律：指南补新容器与 workflow 纪律、**作废「互绑闭包」**、更新 compose 归类表；备份双仓库 | 文档与实态一致 | 低 |

## 七、验收判据（全绿才算完成）

1. `celld-agent-to-rag` 在运行列表、`/health` 正常、L0+L1 闸门通过；
2. 212 篇在新容器可列出、可比对，台账一致；
3. 新会话端到端入库成功（workflow 全链）；
4. **重启续跑实测通过**：处理中 kill 容器，实例从最后完成的 step 续跑，且不重复执行已完成的转写步骤；
5. 插件推送链路正常，一轮对账无积压；
6. 主容器不再引用 kb-sync，multimedia 不受影响；
7. 队列与 KV 锁相关代码/配置已删除，无残留引用。

## 八、退役清单（anti-entropy）

| 旧路径 | 类别 | 处置 |
|---|---|---|
| 队列 `kb-conv-sync` / `-dlq` 及其绑定与消费者配置 | code-retirement | delete-first（workflow 接管重试与状态） |
| KV 锁 `acquireLock/releaseLock/lock:` 键 | code-retirement | delete-first（workflow 单实例天然幂等；顺带消除「拿不到锁就 ack 丢弃消息」的静默丢数据路径） |
| `MM`/`SCHEDULER`/`KBSYNC` service 绑定 | code-retirement | delete-first（实测零调用） |
| 指南第四节「互绑闭包」纪律 | docs | 作废并写明原因 |
| 旧桶 `celld-fleet` 与主容器内 kb-sync | persistent-state | **保留不动**，作为回滚位；退役需用户另行确认 |

## 九、残余风险

- JBB 渠道并发上限**未实测**，「每轮 2」是保守值；后续可由 `jbb` 探针补测。
- KV cell 目录名是 namespace id 的哈希、`own.json` 记旧节点 id —— 迁移兼容性靠 T4 小样验证，若失败则退化为「应用层重灌」（会重烧 212 篇转写费，需用户再批准）。
- workflow 重放纯净若写错，症状是「副作用重复执行」；靠 T6 的重复转写检测兜底（转写有 vision cache，可观察是否命中）。
- 切流后主容器移除 kb-sync 需重启节点（约 20 秒），安排在 T7 验证通过之后。
