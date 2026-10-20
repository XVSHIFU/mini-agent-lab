# Mini Claude Code

本仓库从 [ai-agent-learning](https://github.com/XVSHIFU/ai-agent-learning) 的 `mini-claude-code/` 独立拆分，保留该目录的提交历史。现有实现仍为教学型 Coding Agent；后续专业方向见[开发指导大纲](DEVELOPMENT_OUTLINE.md)，其中专业 Agent 尚待实现。

来源基线：`8bbf59c`；拆分基线：`4592c782f1f7d8ee0b87e1fa15a3362cb47eb380`。原目录未包含独立 LICENSE，本次未擅自添加或变更授权。

一个可以独立复制和运行的教学型 Coding Agent。它使用 JavaScript ESM 编写，零第三方依赖，兼容 OpenAI 风格的 `chat/completions` 接口。

这份目录由最终综合项目整理而来。运行代码、配置示例、测试、ADR 和演示项目都在本目录内，不依赖原学习仓库中的其他章节。

## 能力

- Agent Loop：模型请求工具，程序执行并回填结果，直到任务完成。
- 文件与 Shell 工具：读取、写入、编辑、搜索文件和执行命令。
- 五种权限模式：`default`、`acceptEdits`、`dontAsk`、`bypassPermissions`、`plan`。
- 声明式权限：allow/deny 规则、通配符、原因说明和稳定 `reasonCode`。
- Plan Mode：先只读调查并生成计划，经人工批准后再执行。
- Skills：项目级/用户级发现、正文懒加载、inline/fork 两种上下文。
- 子 Agent：内置 explore/plan/general，也支持 `.claude/agents/*.md`。
- MCP：从配置发现外部 Server，并以 `mcp__server__tool` 路由工具。
- 上下文与记忆：压缩、工具大结果落盘、会话恢复和项目记忆。
- 本地 Trace：使用 JSONL 记录模型、工具、权限、技能和子 Agent 事件。
- 自动化验证：产品行为测试、继承回归测试和任务看板示例测试。

## 环境要求

- Node.js 22 或更高版本，推荐 Node.js 24。
- 使用真实模型时，需要一个兼容 OpenAI Chat Completions 的 API。
- 不需要执行 `npm install`；`package.json` 只提供统一命令，没有第三方依赖。

检查环境：

```powershell
node --version
```

## 30 秒开始

进入本目录：

```powershell
cd C:\path\to\mini-claude-code
```

先运行免 Key 演示：

```powershell
npm run demo
```

再用脚本化 Mock 验证完整 Agent Loop：

```powershell
node src\cli.mjs --mock "Read greeting.txt and summarize it"
```

运行全部自动化测试：

```powershell
npm test
```

三组测试相互独立：

- `npm run test:product`：权限、Skills、Trace、子 Agent 和关键回归。
- `npm run test:unit`：工具、权限、上下文、记忆等基础回归。
- `npm run test:example`：离线任务看板的状态管理测试。

## 连接真实模型

默认配置适配 DeepSeek：

```powershell
$env:AGENT_API_KEY = "sk-xxx"
node src\cli.mjs "读取 README.md，概括这个项目的能力"
```

也可以显式指定模型、接口和输出上限：

```powershell
$env:AGENT_API_KEY = "sk-xxx"
$env:AGENT_BASE_URL = "https://api.deepseek.com/v1"
$env:AGENT_MODEL = "deepseek-chat"
$env:AGENT_MAX_TOKENS = "32768"
node src\cli.mjs
```

支持的环境变量：

| 变量 | 作用 |
|---|---|
| `AGENT_API_KEY` | 首选 API Key |
| `OPENAI_API_KEY` | OpenAI 兼容 Key 的回退变量 |
| `DEEPSEEK_API_KEY` | DeepSeek Key 的回退变量 |
| `AGENT_BASE_URL` | API 基础地址，默认 `https://api.deepseek.com/v1` |
| `AGENT_MODEL` | 模型名称 |
| `AGENT_MAX_TOKENS` | 单次模型输出上限 |

常用参数：

```text
--plan             以只读 Plan Mode 启动
--accept-edits     自动允许文件编辑，危险 Shell 仍需确认
--dont-ask         无法自动允许的操作直接拒绝
--yolo, -y         跳过普通确认，但不能绕过显式 deny 和 Plan 契约
--resume           恢复最近一次会话
--no-trace         关闭本地 JSONL Trace
--max-turns N      限制 Agent Loop 轮数
--max-tokens N     设置模型输出上限
--model NAME       指定模型
--api-base URL     指定 OpenAI 兼容接口
```

查看完整 CLI 帮助：

```powershell
node src\cli.mjs --help
```

## 把它用于其他项目

Agent 始终把当前工作目录视为目标项目。因此，可以把这个目录放在任意位置，再从另一个项目中调用它：

```powershell
cd E:\path\to\your-project
$env:AGENT_API_KEY = "sk-xxx"
$miniClaude = "C:\path\to\mini-claude-code\src\cli.mjs"
node $miniClaude "先只读分析项目结构"
```

此时：

- 文件工具只接收并解析相对于当前项目的路径。
- 当前项目的 `CLAUDE.md`、`.claude/rules/`、`.claude/skills/` 和 `.claude/agents/` 会被发现。
- 当前项目的 `.claude/settings.json` 和 `.mcp.json` 会参与权限与 MCP 配置。
- 会话、Trace、计划和记忆默认写入用户目录，不写进发布包。

## 权限配置

复制示例配置：

```powershell
Copy-Item .claude\settings.example.json .claude\settings.json
```

示例规则：

```json
{
  "permissions": {
    "allow": [
      "read_file",
      { "tool": "run_shell", "pattern": "node --test*", "reason": "允许执行测试" }
    ],
    "deny": [
      { "tool": "run_shell", "pattern": "git push*", "reason": "推送必须人工执行" },
      "run_shell(rm -rf*)"
    ]
  }
}
```

权限优先级：

```text
deny → plan 只读契约 → bypass → allow → 模式/危险检测 → 默认允许
```

`--yolo` 只跳过普通询问，不会绕过显式 deny，也不会破坏 Plan Mode 的只读边界。

## REPL 命令

不传任务即可进入交互模式：

```powershell
node src\cli.mjs
```

| 命令 | 作用 |
|---|---|
| `/help` | 查看交互命令 |
| `/clear` | 清空当前上下文 |
| `/compact` | 主动压缩上下文 |
| `/cost` | 查看演示用成本估算 |
| `/plan` | 切换 Plan Mode |
| `/memory` | 查看项目记忆 |
| `/permissions` | 查看权限规则数量 |
| `/permissions refresh` | 重新加载权限规则 |
| `/skills` | 查看已发现 Skills |
| `/skills refresh` | 刷新 Skills 索引和 System Prompt |
| `/trace 20` | 查看最近 20 条 Trace |
| `/技能名 参数` | 手动调用 Skill |

## 数据位置

运行时数据默认位于用户目录：

```text
~/.mini-claude/sessions/       会话
~/.mini-claude/traces/         JSONL Trace
~/.mini-claude/tool-results/   超出输出预算的工具结果
~/.mini-claude/projects/       按项目隔离的记忆
~/.claude/plans/               Plan Mode 计划文件
```

项目级扩展位于目标项目：

```text
.claude/settings.json          权限与 MCP 配置
.claude/skills/*/SKILL.md      Skills
.claude/agents/*.md            自定义子 Agent
.claude/rules/*.md             项目规则
.mcp.json                      MCP Server 配置
CLAUDE.md                      项目上下文
```

Trace 会隐藏常见密钥字段、Bearer Token 和 `sk-...` 字符串，但分享日志前仍应人工检查。

## 任务看板示例

`examples/task-board/` 是 Agent 完成的零第三方依赖示例项目。

运行测试：

```powershell
npm run test:example
```

启动静态服务器：

```powershell
npm run example:task-board
```

浏览器打开 `http://localhost:3001/`。更多说明见 `examples/task-board/README.md`。

## 目录结构

```text
mini-claude-code/
├── .claude/
│   ├── settings.example.json
│   └── skills/review/SKILL.md
├── docs/adr/                    技术决策记录
├── examples/task-board/         Agent 实战生成的离线任务看板
├── src/                         Agent 运行代码
├── test/
│   ├── product-tests.mjs        产品行为和关键回归
│   ├── unit-tests.mjs           基础确定性回归
│   └── checklist.md             手动验收清单
├── demo.mjs                     免 Key 一键演示
├── greeting.txt                 Mock 演示输入
├── package.json                 统一运行命令
└── README.md
```

核心模块：

| 文件 | 职责 |
|---|---|
| `src/agent.mjs` | Agent Loop、模型适配、Plan、子 Agent 和 Trace 接线 |
| `src/tools.mjs` | 工具定义、注册与执行 |
| `src/permissions.mjs` | 声明式权限策略与危险检测 |
| `src/context.mjs` | 输出预算与上下文压缩 |
| `src/memory.mjs` | 项目记忆 |
| `src/skills.mjs` | Skills 发现、懒加载和执行 |
| `src/subagent.mjs` | 内置与自定义子 Agent 配置 |
| `src/mcp.mjs` | MCP 生命周期、发现和路由 |
| `src/trace.mjs` | 本地 JSONL 可观测性 |
| `src/cli.mjs` | 参数解析、单次模式和 REPL |

设计背景见 `docs/adr/`，更细的人工验证步骤见 `test/checklist.md`。

## 安全边界

这是教学项目，不是经过安全审计的生产沙箱：

- Shell 工具会在当前工作目录执行真实命令。
- 默认模式会询问危险操作，但规则和正则检测不可能覆盖所有命令语义。
- MCP Server 是外部进程，应只配置你信任的程序。
- 模型输出、工具结果和第三方文件都可能包含 Prompt Injection 内容。
- 对重要仓库使用前，请先提交或备份本地改动，并保持人工审阅。

建议先使用 `--plan` 或默认权限模式熟悉行为，不要把 `--yolo` 当作安全沙箱。
