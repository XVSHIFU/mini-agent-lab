# ADR-0003：优先本地 JSONL，而不是强依赖 Langfuse

- 状态：Accepted
- 日期：2026-08-22

## 背景

README 提供 Langfuse 或日志打点两个方向。Langfuse 的查询和可视化更完整，但会引入 SDK、账号、网络和环境变量，不利于“clone 后 10 分钟内运行”的验收目标。

## 决策

第一版使用零依赖 JSONL：每个会话一个文件，每行一个完整事件，父 Agent 与子 Agent 共用记录器。`agentId`、`parentAgentId` 和 `spanId` 负责关联调用链；模型响应记录 token usage 和演示价格下的估算成本。写入失败只记在 `lastError`，不让可观测性拖垮 Agent 主流程。

默认对敏感字段、Bearer token、`sk-...` 做脱敏，字符串超过 2,000 字符时截断。CLI 用 `/trace N` 展示最近事件，也允许用 `--no-trace` 完全关闭。

## 影响

优点是本地可用、容易 grep、没有服务依赖，也可以直接作为 bug 报告附件。缺点是没有跨会话查询、瀑布图和团队仪表盘。以后若接入 Langfuse，应把当前 JSONL 记录器保留为本地适配器，再增加远端适配器；事件语义不应绑死在某个供应商 SDK 上。
