# mini 专业 Agent 开发指导大纲

以现有 mini 为基础，边学习开源实现，边完成范围明确的专业 Agent。

## 1. 专业 Agent：以 mini 为基础，依次完成三个小项目

每次只做一个方向。顺序是：**Kubernetes 故障调查 → 安全告警复核 → 基础设施配置审查**。按需结合云计算与安全学习，不必等所有课程完成。

| 顺序与方向 | 参考开源项目 | 重点学什么 | 做到什么程度就停 |
| --- | --- | --- | --- |
| ① Kubernetes 故障调查 Agent | [kubectl-ai](https://github.com/GoogleCloudPlatform/kubectl-ai)、[HolmesGPT](https://github.com/HolmesGPT/holmesgpt) | 领域工具设计、查询日志与事件、关联配置、给出有证据的判断 | 只读调查；覆盖镜像拉取失败、探针配置错误、Service selector 错误三类场景。输出原因、证据与建议；权限不足或证据不足时明确说明。首版不做自动修复 |
| ② 安全告警复核 Agent | [Tracecat](https://github.com/TracecatHQ/tracecat) | 区分确定性数据处理与模型判断；关联请求、响应和规则；记录人工反馈 | 输入公开或合成的 HTTP 告警，输出攻击尝试、规则误报或证据不足，并单独判断攻击是否成功。先覆盖 URI 子串误匹配、参数内嵌 URL、登录重定向三个场景；不接企业数据、不自动封禁 |
| ③ 基础设施配置审查 Agent | [Terraform MCP Server](https://github.com/hashicorp/terraform-mcp-server) | 查询准确的资源文档、结合配置解释风险、验证修改建议 | 只处理一个提供商的 Terraform 配置，检查存储公开访问、管理端口暴露、权限过宽三类问题；给出配置位置、依据和修改建议，并做语法校验。首版不执行 apply，不做多云平台 |

这些项目用于参考设计，不照搬全部功能。Tracecat 部分能力属于企业版；Terraform MCP 是工具服务，不是完整 Agent，本地校验需要自行接入。

**共同完成标准：**每个方向准备 5—10 个固定案例，包含正常、异常和信息不足情况；留下启动说明、测试记录和一个演示。根据实际证据检查结论，记录失败案例，不以“能聊天”或“模型自称成功”为验收标准。

**控制范围：**新增功能必须解决一个已有案例的问题，否则先放到后续清单。首版不加 Web 界面、多用户、复杂多 Agent 或长期记忆。权限边界与失败处理属于基础要求，测试明确暴露的问题需要修好。

## 2. 独立仓库分工

将 [mini-claude-code](https://github.com/XVSHIFU/ai-agent-learning/tree/main/mini-claude-code) 已拆分到本地 `E:\AI-AGENT\mini-claude-code`，GitHub 仓库待创建：

- **原 ai-agent-learning：**保留学习笔记和教学版本，在 README 链接新仓库。
- **新仓库：**以当前 mini 为起点，共用模型调用、工具执行、权限和 Trace；每个专业方向单独放工具、提示词、案例与说明，避免复制多套核心。
- **迁移原则：**先跑通现有测试，保留来源、许可证和必要署名；仅在实际复用需要出现时调整目录，不先重写框架。

建议逐步形成：

```text
src/                       # 共用 Agent 核心
examples/
  k8s-investigator/        # Kubernetes 调查
  alert-reviewer/          # 告警复核
  infra-reviewer/          # 配置审查
test/                      # 共用行为与权限测试
```

先建立第一个示例，其余按顺序增加。新仓库作为持续开发入口，原仓库保留教学快照，避免两边重复维护。

## 3. 后续深入

三个方向不要求都做成完整产品。完成后选最有兴趣、最有实际效果的一个深入：

- **评测：**参考 [AIOpsLab](https://github.com/microsoft/AIOpsLab)，研究标准故障场景与独立验收。
- **Agent 平台：**参考 [kagent](https://github.com/kagent-dev/kagent)，研究部署、会话与可观测性。
- **执行隔离：**参考 [Container Use](https://github.com/dagger/container-use)，研究独立执行环境和结果审查。

安全评测融入各方向：加入日志或样本中的提示注入、越权工具请求，使用虚构凭据验证实际行为。无需先建设一套大型评测平台。

每个方向最终保留 **代码 + 验证结果 + 简短总结**，说明参考了什么、自己改了什么、还有哪些限制，再整理进博客和简历。
