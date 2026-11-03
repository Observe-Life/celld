# kb-sync（celld 版）

「智能体会话 → 知识库」同步工作流。自 OC（open-compute）重写到 celld，业务逻辑与 OC 版等价，去掉了为适应 OC 局限而写的部分。

## 相对 OC 版的改动
1. 去掉 oc-egress 跳板：外网（shapi.vip、外链图片）直连。
2. 幂等短路（OC 上规划未部署）：处理前查台账，已是最新且解析成功 → 跳过。重复投递零成本。
3. 定时触发恢复启用（OC 上因部署问题被迫注释）：每小时 37 分，一轮最多补 10 篇。
4. md 体积保险丝 6MB → 20MB（celld 请求体上限 1GiB）。
5. 队列加死信队列 kb-conv-sync-dlq。
6. OC 的 cf/config DSL + vite 构建 → 标准 wrangler.jsonc + esbuild（celld deploy 原生）。

## 不变的部分
- kb-writer 数据通道（cfkit:8601）：读 AstrBot 会话库、同步区文件夹读写、台账存取。
- 文件夹唯一源头：md 先落盘再读回上传。
- WeKnora API 封装、md 转换、Gemini 转写提示词。
- 台账结构（/api/state）与 OC 版兼容，无缝接续。

## 白名单（测试期）
vars 里的 SYNC_ALLOWLIST：逗号分隔的会话 uuid。设置后对账（含删除检测）只作用于白名单内会话；留空即全量。
deploy.sh 第一个参数即白名单。

## 部署
    ./deploy.sh <uuid1>,<uuid2>
