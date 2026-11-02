# multimedia-pipeline（celld 版）

多来源多媒体内容转写与总结工作流，自 OC（open-compute）重写到 celld。
业务逻辑与 OC 版逐行等价：B站视频/图文、公众号文章、小红书、视频号、网页、文件六路输入，
Gemini 转写与总结，Supabase 持久化，Server酱通知。

## 触发方式

    POST http://celld:8080/run   {"url": "<内容链接>"}
    POST http://celld:8080/status {"id": "<实例id>"}   # celld 版新增

## 相对 OC 版的改动

1. **步骤结果 1 MiB 上限适配（celld 特有差异）**：网页/公众号正文在进入步骤结果前截断到
   30 万字符（约 900KB UTF-8）。OC 版无此限制，正文最长 90 万字符直通。
2. summarize 输入切片 90 万 → 30 万字符，与上游截断对齐。
3. 压缩保险丝阈值 38 万 → 90 万字符：原阈值是为 OC 步骤体积限制设的，celld 下由
   上游 30 万截断兜底，此函数降级为极端保险。
4. 新增 /status 端点（OC 版没有，运维查实例状态用）。
5. 去掉 nodejs_compat 兼容标记（代码只用 Web 标准 API，celld 下不需要）。

## 不是 OC 局限、保留不变的部分

- **egress 跳板（oc-egress:8888）**：NAS 出境网络的现实需要（Google/CF 域名直连不通、
  shapi.vip 大载荷直连被掐），不是 OC 的局限。已实测保留。
- **步骤重试 {limit:1, delay:2000}**：省 tikhub 接口配额的策略选择，非 OC 局限。
- **eB 业务逻辑**：六路平台的抓取/解析/转写/持久化/通知，逐行保留。

## 已知边界

- celld 已知 issue #299：单步运行超过 CELLD_HANDLER_BUDGET_S（当前 900 秒）会终止实例。
  长视频的 gemini 步骤理论上可能触达，目前容器已放宽到 900 秒。
- 步骤结果上限 1 MiB：超长网页正文会被截断（结果里带 truncated 标记）。

## 部署

    ./deploy.sh
