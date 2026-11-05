# 【必读】celld 使用指南

## 目录

- 一、最高指导
  - （一）指导原则的修改权限
  - （二）基本框架
  - （三）与 Cloudflare 的差异
- 二、镜像构建
  - （一）celld 本体与运行镜像
  - （二）待命与唤醒容器镜像
- 三、容器部署
  - （一）compose 规范
  - （二）容器归类与拓扑
  - （三）待命容器的标准做法
  - （四）内存与资源闸门
- 四、首次配置
  - （一）环境变量
  - （二）`CELLD_DURABILITY` 不要动
  - （三）占位 cron
  - （四）密钥注入
- 五、日常使用
  - （一）常用端点
  - （二）改配置后怎样才能生效
  - （三）排查时的两个工具坑
- 六、源码修改
  - （一）加一个新实例
  - （二）service 绑定原则
  - （三）部署顺序
  - （四）队列投递
  - （五）celld-agent-to-rag 的执行模型
- 七、平台硬限制与已知缺陷
  - （一）四条硬限制
  - （二）上游缺陷 #276
  - （三）已知缺陷
- 八、纪律
- 九、知识召回体系状态

---

## 一、最高指导

### （一）指导原则的修改权限

> **警告**：该部分内容作为整篇文档、整个项目的指导原则，仅可由用户修改，AI禁止主动修改，但可以提建议让用户授权修改。

### （二）基本框架

* **一个 celld 实例**：由一个或多个 celld 功能模块组成
* **一个 celld 容器**：由一个或一组互相关联的 celld 实例组成（上游英文文档称 fleet，本框架统一叫**容器**）
* **celld 容器的分类**
  1. **活跃容器**：高频使用；持续占用一定的算力、内存
  2. **待命容器**：低频使用；按需唤醒、闲置自停，暂停时容器仍在「正在运行的容器列表」，但只占用极少的算力、内存
* **celld 容器的命名规范**：`celld-XXX-XXX`（celld 后面跟的字段为 2～3 节）
* **所有实例源码的存放文件夹**：`/vol1/docker/celld/实例/`
* **所有实例容器镜像源码的存放文件夹**：`/vol1/docker/celld/实例容器镜像源码/`

### （三）与 Cloudflare 的差异

Cloudflare 账号级平台天然支持「N 个独立 worker 各自部署、各自定时、互不干扰」；celld 的定位是「**一个容器只跑一个应用**」（README L214），没有账号级多应用调度。本架构用「中央调度器 + 部署顺序约定」在单个 celld 容器内重建了 CF 的使用体验：worker 数量增长不增加容器，定时规则增长只改一张表。低频能力则不进 celld 容器，改为独立的待命容器 + 活跃唤醒容器。

代价是 celld 把很多运维开关留给了默认值，且默认值偏向「不约束」——**三（四）的三个闸门就是最典型的例子**。

---

## 二、镜像构建

### （一）celld 本体镜像

**我们不构建 celld 本体**。运行用的是上游镜像 `ghcr.io/denoland/celld:latest`（由上游 `release.yml` 云构建，仓库里的 `Dockerfile` 是从 Rust 源码构建本体的定义，我们未使用）。

### （二）待命与唤醒容器镜像

1. 源码在 `实例容器镜像源码/` 下，目前两个：`celld-typescript-check`、`celld-wake-container`。
2. 由 `.github/workflows/ts-check-images.yml` **云构建**，产出 `ghcr.io/observe-life/<名字>:latest`。
3. 触发条件：`实例容器镜像源码/**` 或该工作流文件本身变化，也可手动 `workflow_dispatch`。
4. 该工作流构建后还会跑一次冒烟验证（起空壳容器、确认 PID 1 是 `sleep`）。

### （三）`celld-full:latest`（本地构建的例外）

由仓库根 `Dockerfile.toolbox` 构建，内容就是**上游 celld 镜像 + 预下载的 esbuild**（`FROM ghcr.io/denoland/celld:latest`）。`celld`、`celld-agent-to-rag`、`celld-knowledge-recall` 三个服务共用它，只靠 `CELLD_BUCKET` 与挂载卷区分身份。

这是唯一一个本地构建的镜像（compose 里带 `build:` 段）。按纪律构建一律走 GitHub Actions 云构建，要改这个必须先把 esbuild 依赖挪进云工作流，或取得用户明确许可。

---

## 三、容器部署

### （一）compose 规范

1. **所有 celld 相关容器一律放进同一个 compose**：`/vol1/docker/celld/compose.yaml`（含主容器、minio/minio-init、全部待命与唤醒容器）。一个 compose 项目就是「这套东西都属于 celld」的边界，面板里归在同一应用条目下，启停、备份、容灾迁移也以它为单位。
2. **禁止**为待命/辅助能力另开 compose 或用裸 `docker run` 长期常驻。
3. 容器之间一律「容器名:机内端口」；**不得**为容器间调用开宿主端口映射。

### （二）容器归类与拓扑

| 容器 | 归类 | 内容 |
|---|---|---|
| `celld` | 活跃 | scheduler + multimedia（会话同步已拆出）；桶 `s3://celld-fleet` |
| `celld-agent-to-rag` | 活跃 | 会话导入知识库，Workflow 形态，自己就是本容器的根；桶 `s3://celld-rag` |
| `celld-knowledge-recall` | 活跃 | knowledge-recall（根）+ knowledge-timeline-impression（cohosted）；桶 `s3://celld-recall` |
| `celld-wake-container` | 活跃 | 待命容器的唯一唤醒入口，挂 `docker.sock` |
| `celld-typescript-check` | 待命 | 空壳，node 进程仅在检查的 1-2 秒内存在 |

```
celld（s3://celld-fleet）
├── scheduler              ← 根：cron 表 + 前门转发（/mm/*）
└── multimedia-pipeline    ← 多媒体转写（Workflows）
celld-agent-to-rag（s3://celld-rag）
└── celld-agent-to-rag     ← 根：cron + Workflow 会话同步
celld-knowledge-recall（s3://celld-recall）
├── knowledge-recall                  ← 根：场景配比、三通道并行、融合、预算、渲染
└── knowledge-timeline-impression     ← cohosted：时间轴与画像，D1 唯一写者
celld-typescript-check（待命）+ celld-wake-container（唤醒入口）
```

跨容器**没有** service 绑定（celld 的 `services` 只在同一容器内有效），容器间互访只能走「容器名:机内端口」的 HTTP。

### （三）待命容器的标准做法：空壳常驻 + 按需 exec

**不要**给待命容器装 HTTP 服务再用 start/stop 编排：

1. **容器常驻**，PID 1 是 `sleep` 空壳（实测约 900KiB），因此始终在运行列表里，不会被判定成垃圾镜像。
2. **吃资源的进程按需 `docker exec` 拉起、用完即走**，只走 stdin/stdout、不监听端口，所以待命容器不需要任何网络地址。唤醒方是持有 `docker.sock` 的活跃容器，只承担「唯一入口 + 权限隔离」。
3. 采用此形态就**连带删掉三套机制**：就绪轮询、空闲看门狗、SIGTERM 优雅退出。缺 SIGTERM 时 `docker stop` 会白等满宽限期再被 SIGKILL，退出码 137 在面板显示成「错误退出」，把正常回收误报成故障。

### （四）内存与资源闸门

celld 的内存开关**默认全部不设限**。这三项不在 compose 的 `environment` 里显式配置，默认值就是「不约束」：

| 配置 | 不设置时的默认行为 | 出处 |
|---|---|---|
| `CELLD_MAX_RESIDENT_CELLS` | **常驻 cell 数无上限**（`usize::MAX`）。源码注释：*"celld has no resident ceiling unless the operator configures one"* | `main.rs` L3640 |
| `CELLD_IDLE_EVICT_S` | **空闲驱逐整个功能关闭**（`positive()` 返回 `None`，逻辑第一行即 `return`） | `actor.rs` L2567 + `logic/lib.rs` L6108 |
| `CELLD_MAX_RSS_MB` | **水位线取 cgroup limit 的 80%**，即它会主动把内存爬到 limit×0.8 才开始释放 cell | `logic/pressure.rs` L165 |

三者叠加的后果（2026-11-05 实测）：agent-to-rag 限额 512 MiB → 水位线 409 MiB → 它一路爬到 342~400 MiB 且**在 celld 看来一切正常**；主容器 937 MiB / 1 GiB。**这不是泄漏，是照默认策略办事。**

我们的取值与效果：

| 容器 | `CELLD_MAX_RSS_MB` | `CELLD_MAX_RESIDENT_CELLS` | `CELLD_IDLE_EVICT_S` |
|---|---|---|---|
| `celld` | 512 | 64 | 120 |
| `celld-agent-to-rag` | 160 | 32 | 120 |
| `celld-knowledge-recall` | 256 | 32 | 120 |

效果：agent-to-rag 342 → 55~79 MiB 稳定；主容器 937 → 63 MiB；主容器 `data/state` 8.9 G → 2.1 G。
**调整容器 `mem_limit` 时必须同步重算 `CELLD_MAX_RSS_MB`**，否则水位与限额脱节。

---

## 四、首次配置

### （一）环境变量

每个 celld 容器的 `environment` 必配项：

1. `CELLD_BUCKET`：本容器的桶（`s3://celld-fleet` / `celld-rag` / `celld-recall`），配合 `S3_ENDPOINT`、`AWS_REGION`、`AWS_ACCESS_KEY_ID`、`AWS_SECRET_ACCESS_KEY`。
2. `CELLD_WATCH=/var/lib/celld/state`，挂载卷 `<宿主机>/data:/var/lib/celld`。
3. 三个内存闸门，取值见三（四）。
4. `CELLD_HANDLER_BUDGET_S=900`：多图转写 + 等解析会超过默认 300s。
5. `CELLD_LTX_RETENTION_SECS=604800`：epoch GC 兜底（作用有限，见八、纪律）。

### （二）`CELLD_DURABILITY` 不要动

默认 `fleet` 的语义（`docs/services/durable-objects.md` 原文）：

> *"On a single node, every write waits for the object store."*

所以这条日志 **不是故障**，它只是在陈述「就我一个节点，那我直接找对象存储盖章」：

```
fleet durability requested and no peer is available; writes wait for the bucket.
```

曾据此把三个容器改成 `bucket`，属误判，已于 2026-11-05 回退。原因：单节点下两者等价（零收益），而 `bucket` 的语义是「**即使同伴节点可用也永远等对象存储**」，将来扩多节点反而更慢。**配置里不应存在该项。**

### （三）占位 cron

桶里只要有 `.cron:<实例名>` 注册，Worker 就必须导出 `.cron` class，否则触发七（二）的 #276。而 class 是否导出取决于 `triggers.crons` 是否非空。所以**暂时不想要定时任务时，不能写 `"crons": []`，也不能删 `triggers` 段**，要留一个极低频占位：

```jsonc
"triggers": {
  // 占位 cron：每年 1 月 1 日 00:00。目的只是让 Worker 导出 .cron 这个 DO class。
  // 留空数组或删除本段，桶里已有的 .cron cell 注册仍会被尝试激活，却找不到
  // DO class，于是无限失败重试，每次失败泄漏一个 epoch。恢复真实节律改本行即可。
  "crons": ["0 0 1 1 *"]
},
```

scheduler 与 celld-agent-to-rag 都用这个写法。前者此前正因 `"crons": []` 以每分钟 192 次失败泄漏。

### （四）密钥注入

1. `wrangler.template.jsonc` 里只写 `@RAGF_KEY@` 这类占位符，**模板进仓库**。
2. 真值放在同目录 `secrets.json`，由 `deploy.sh` 注入生成 `wrangler.jsonc`；**成品文件含明文密钥，不得进仓库**。
3. 提交前必须扫描暂存内容是否含明文凭据，并确认 `secrets.json` 与成品 `wrangler.jsonc` 未被跟踪。

---

## 五、日常使用

### （一）常用端点

| 端点 | 用途 |
|---|---|
| `GET /health`（各容器 8080） | 服务与已注册调度表 |
| `POST /fire {"cron":"..."}`（scheduler） | 手动触发一条调度，验证派发链 |
| `POST /run`、`GET /status?uuid=`（`celld-agent-to-rag:8080`） | 立即对账一轮；查 Workflow 实例进度 |
| `GET /recall?q=&budget=`（`celld-knowledge-recall:8080`） | 三通道召回，返回含 `degraded` 列表 |
| `GET /kb/*`（`celld:8080`） | **已退役**，返回 404 并提示新地址 |

### （二）改配置后怎样才能生效

| 改了什么 | 怎样生效 |
|---|---|
| compose 的 `environment`（含三个内存闸门） | **必须 `docker compose up -d --force-recreate`**。`docker restart` 与 `docker compose restart` 都**不会**重读 environment，实测 restart 后容器内仍是旧值 |
| cohosted 组件的 worker 代码 | 重新部署根，或重启节点 |
| 根 worker 的代码或 vars | 约 15-25 秒自动采纳，无需重启 |

### （三）排查时的两个工具坑

1. **minio 容器里预置的 `mc` alias 凭据是错的**，`mc ls` 会报 `Access Denied`。要用容器自身环境变量重配：`mc alias set local2 http://localhost:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"`。
2. **`mc` 失败与「对象数确实为 0」在输出上无法区分**，务必用 `du -sh /data/<桶>` 交叉验证，别把命令失败当成事实。同理，`find -type f` 在 minio 的 XL 布局下也统计不到对象。

---

## 六、源码修改

### （一）加一个新实例

1. 新建 `/vol1/docker/celld/实例/<name>/`；
2. **只在真正会调用它的实例上**加 `services` 绑定（不要全量互绑，见六（二））；
3. 需要定时：在该实例所在容器**的根**上写 `triggers.crons`，或加进 scheduler 路由表；
4. 跑该实例的 `deploy.sh`（自动含闸门与重启提示）。

### （二）service 绑定原则

**只在真正会调用的实例之间声明绑定**（现状仅 scheduler ↔ multimedia）。~~「全部 worker 互绑」~~ 已于 2026-11-03 **作废**——全量 grep `env.*` 使用计数确认那些绑定是纯声明、零调用。

**但作废它留下了一个新坑**：被解绑实例的 cell 注册仍留在桶里，于是触发 #276。退役实例必须连带清注册。

### （三）部署顺序

1. 一次部署多个实例：**先 cohosted、最后根**，靠根 bundle 变化带动闭包，不需重启。
2. 单独部署 cohosted：**必须重启节点**（或随后重新部署根）。
3. 只改根：15-25 秒自动采纳。
4. 带 cron 的实例必须是它所在容器的根，所以部署脚本都把根放在最后。

### （四）队列投递

`sendBatch` 必须按 ≤100 条分片：

```ts
for (let i = 0; i < uuids.length; i += 100) {
  await env.QUEUE.sendBatch(uuids.slice(i, i + 100).map((uuid) => ({ body: { uuid } })));
}
```

### （五）celld-agent-to-rag 的执行模型

1. 一个会话一个 Workflow 实例，实例号 = `uuid-版本`。同版本重复触发由平台静默去重（`createBatch()` 对已存在实例号返回 `created:false`），因此**不需要 KV 锁**——旧实现用 KV 时间戳锁，拿不到锁就 `message.ack()` 丢弃消息，存在静默丢数据路径。
2. 等解析用 `step.sleep` + 短查询步骤，不在 handler 里同步轮询；等待期间实例休眠、不占 isolate。
3. 转写步骤结果持久化：重放或重试不会再烧一次转写费。每轮最多创建 2 个实例（`SYNC_CONCURRENCY`）。
4. 步骤结果/入参各 ≤1MiB，所以 raw 与 md 本体留在 R2、步骤只回摘要与哈希。
5. 平台差异：`status()` 只返回 `{status, rollback}`，**没有 steps 数组**；终态字符串是 `complete`（不是 `completed`）。
6. **实例数不回收**：celld 无注销 cell 的命令，历史 Workflow 实例会一直留在桶里（实测已积 264 个），只能靠闸门上限压制。
7. **JSONC 只支持 `//` 与 `/* */` 注释，`#` 会让解析失败**（`wrangler.jsonc` 尤其容易写错）。

---

## 七、平台硬限制与已知缺陷

### （一）四条硬限制（源码取证）

| # | 限制 | 出处 |
|---|---|---|
| 1 | **一个容器同一时刻只跑一个「应用根」**：每次 `celld deploy` 无条件改写全局指针 `deploy/current.json`，谁最后部署谁当根 | `crates/celld/deploy.rs` L937 |
| 2 | **cron 只有「根」会触发**；被 service 绑定带进来的 cohosted worker，其 cron 永不触发（只警告不报错） | `crates/celld/generation.rs` L210 |
| 3 | **cohosted 组件单独更新不会自动生效**：节点只在根指针变化时重走依赖闭包。实测改 cohosted 后等 60 秒无效、重启立即生效 | 实测 |
| 4 | **队列 `sendBatch` 单次上限 100 条**，超出报 `QUEUE_ERROR: a batch has at most 100 messages` | `crates/logic/queue.rs` |

### （二）上游缺陷 #276：失败的 DO 启动会自我繁殖

1. **机制**：cell 注册还在桶里，但当前 Worker 没导出它的 Durable Object class → 每次激活失败 → **每次失败又写一个新 epoch** → 链越来越长 → 每次尝试都要读整条链 → 内存与磁盘同时上升，永不收敛。
2. **实测规模**：一个 KV cell 因此攒到 12,008 个 epoch / 6.7 GB，且读不出任何业务键（`RuntimeFailed`）。
3. **两个触发条件**（都很容易无意中制造）：① `triggers.crons` 写成空数组或删掉整段 `triggers`；② 实例退役后它在桶里的注册不会自动消失。
4. **处置（顺序不能错）**：
   1. 让 Worker 能导出该 class（见四（三）占位 cron），或确认该 cell 确实不再需要；
   2. **删桶里的注册**——`celld cell` 只有 `list` 与 `gc`，**没有注销 cell 的命令**，只能直接删对象存储的 `cells/<cell>/` 前缀；
   3. **重启节点**——桶删了但进程内存里的 ownership 记录还在，不重启仍会重建。
5. 只删本地 `data/state/` 目录**无效**：celld 会从桶恢复，实测 40 秒内又长出 93 个 epoch。

### （三）已知缺陷（如实记账，未粉饰）

1. **画像的同键取代实际不生效**：`normalized_key` 目前是「kind + 内容前 24 字」，文字略有不同就是不同键，同一事实的多个变体会同时 active。近义合并需要 LLM 参与，尚未实现。当前只有调用方显式传入 `normalized_key` 时取代才成立。
2. **中文短词必须回退 LIKE**：trigram 需 ≥3 字符，已在数据层实现，**不得移除**。
3. **定时对账 cron 目前是占位表达式**（每年一次），即定时对账与自愈不运行；增量推送路径不受影响。恢复方式见四（三）。

---

## 八、纪律

1. **带 cron 的实例必须是它所在容器的根**；每个容器的部署脚本都把根放在最后部署。
2. **三个内存闸门不得省略**（三（四））——这是本套容器内存是否可控的唯一开关。
3. **实例退役必须连带清理它在桶里的 cell 注册**，否则触发 #276。
4. **`CELLD_LTX_RETENTION_SECS=604800` 只是兜底，不能当主要手段**：GC 只能删 restore 链 base 之下的 epoch，而 base 要靠压缩才会前进；失败循环期间压缩不跑，retention 设了也删不掉任何东西。真正的解法是消除失败源。
5. **大表批量删除前先建索引或按主键点名**（与 celld 无关，但在同一台 NAS 上吃过全表扫描的亏：4GB 库机械盘 1 小时 0 写入）。
6. **SQLite 热备份必须用 backup API，不能 `cp`**；`docker compose stop` 是异步的，进程仍在写时复制会得到撕裂文件。

---

## 九、知识召回体系状态

已上线（P0–P3）：`celld-knowledge-recall` 容器 + 插件 `astrbot_plugin_knowledge_recall`（零存储）。

素材后端已于 2026-11-04 由 weknora-lite **切换为 rag-ferrite**（Rust，混合检索）。原因：weknora-lite 向量段在 19,046 个向量上 60 秒不返回（sqlite-vec 无 KNN 索引），召回层被迫只跑关键词；rag-ferrite 全链路实测 0.17–0.79 秒，向量与关键词两段现已同时工作。切换后 `disable_vector_match`、`RECALL_CORPUS_VECTOR`、`RECALL_KB_IDS` 三个配置已删除。附带收益：素材文件名 `会话-{uuid}-{标题}.md` 可提取会话 uuid，使经验通道与时间轴通道**首次能对齐**。

---
*最后更新：2026-11-05。改动 celld 部署结构前请先读本文并对照源码行号复核（上游版本迭代可能改变行为）。*
