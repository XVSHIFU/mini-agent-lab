# 08 · 完整功能手动验收清单

> 手动验收场景。自动化测试跑 `node test/unit-tests.mjs`（26 项继承回归）和 `node --test test/product-tests.mjs`（17 项 08 行为测试）。
> 这套手动清单覆盖自动化没断言到的真实模型判断和交互手感。
> 全部用 `--yolo`（跳过确认）跑，命令以我们的实现为准（`node src\cli.mjs`）。

## 准备

```powershell
$env:AGENT_API_KEY = "sk-xxx"
cd .\mini-claude-code
node src\cli.mjs --yolo          # REPL
```

## Phase 1: 基础工具（Test 1-3）

### 1. MCP 工具调用 —— 防"外部工具挂载/路由"回归
```
用 MCP 的 add 工具算 17+25
```
✅ 启动时看到 `[mcp] Connected to ...`；工具名带 `mcp__` 前缀；add 返回 42。
**防什么**：MCP 握手、工具发现、三段式前缀路由、透明转发任何一环坏了都会在这暴露。

### 2. WebFetch —— 防"HTTP 获取/HTML 清洗"回归
```
Fetch https://example.com and tell me what the page is about.
```
✅ 返回 HTML 转纯文本后的内容。
**防什么**：fetch 超时、去标签逻辑、50KB 上限。

### 3. 并行工具执行 —— 防"退化成串行"回归
```
Read src/frontmatter.mjs and src/session.mjs at the same time, then tell me each file's line count.
```
✅ 多个 `read_file` 同时出现（不是一个个来）。
**防什么**：并发安全工具的 Promise.all 批次逻辑。

## Phase 2: 记忆与上下文（Test 4-7）

### 4. 语义记忆召回 —— 防"记忆保存/预取/注入"回归
```
Save a memory: type=project, name="staging", content="Staging server: https://staging.example.com"
```
退出重启新对话：
```
Read package.json, then tell me: where can I deploy to test?
```
✅ 召回 staging 记忆，答 `https://staging.example.com`。
**防什么**：save_memory 工具、异步预取、sideQuery 语义选择、注入时机。

### 5. @include + Rules —— 防"CLAUDE.md 加载"回归
`.claude/rules/` 放一条 `When the user greets you, respond in Chinese`，然后：
```
Hello!
```
✅ 模型用中文回复。
**防什么**：CLAUDE.md 向上遍历、@include 解析、rules 自动加载。

### 6. Read-before-edit —— 防"盲写覆盖"回归
```
Edit src/tools.mjs and change MAX_RESULT_CHARS to 99999. Do NOT read it first.
```
✅ 工具层返回 `must read this file before editing`（或模型自动先读）。
**防什么**：readFileState 的 mtime 凭证机制。

### 7. 大结果持久化 —— 防"大输出撑爆上下文"回归
```
Read the file test/large.txt   （先造一个 >30KB 的文件）
```
✅ 输出含 `[Result too large (...). Full output saved to ...]` + 前 200 行预览。
**防什么**：persistLargeResult 的 30KB 阈值 + 预览 + 指针。

## Phase 3: 技能与工具扩展（Test 8-10）

### 8. Skill 调用 —— 防"技能发现/展开"回归
```
/greet Alice      （.claude/skills/greet/SKILL.md）
```
✅ 模型按技能 prompt 执行，生成对 Alice 的问候。
**防什么**：技能发现（user+project）、frontmatter 解析、$ARGUMENTS 替换。

### 9. ToolSearch —— 防"deferred 懒加载"回归
```
Use tool_search to find the "plan mode" tool.
```
✅ 返回 enter/exit_plan_mode schema，之后这些工具被激活。
**防什么**：deferred 工具冷启动隐藏 + 搜索激活。

### 10. REPL 命令 —— 防"命令处理"回归
```
/cost  /memory  /compact  /plan  /plan（再切回）
```
✅ 各命令正常响应。
**防什么**：命令分发、token 统计、记忆列表、压缩、模式切换。

## Phase 4: Agent 架构（Test 11-12）

### 11. Sub-agent 系统 —— 防"子 Agent 隔离/工具限制"回归
```
Use the agent tool with type "explore" to find all files importing "./memory.mjs" in src/.
```
✅ 输出 `┌─ Sub-agent [explore]` 标记；只使用只读工具；返回文件列表。
```
Use the agent tool with type "general" to create /tmp/agent-test.txt with content "test".
```
✅ general 能写文件；子 Agent 结果回主对话。
**防什么**：explore 只读工具集、general 排除 agent 防递归、fork-return 结果回填、输出 buffer。

### 12. Plan Mode —— 防"只读约束/审批流"回归
```
/plan
Read package.json, then create a plan. Write it to the plan file.
```
✅ 能读、能写 plan 文件、写其他文件被 `Blocked in plan mode` 拦。
等模型调 `exit_plan_mode` → 出现四选一 → 选 2 执行 / 选 4 给反馈。
**防什么**：plan 文件白名单、plan 提示注入、审批回调、clear-and-execute 清上下文。

## Phase 5: 编辑与搜索（Test 13, 17-18）

### 13. 引号规范化 —— 防"弯引号编辑失败"回归
用弯引号（U+201C/U+201D）要求 edit_file 替换一段文本。
✅ 输出含 `(matched via quote normalization)`。
**防什么**：normalizeQuotes 回退匹配，返回文件原始字符串。

### 17. Grep Search —— 防"搜索"回归
```
Use grep_search to find "DANGEROUS_PATTERNS" in the project.
```
✅ 返回 `路径:行号:内容` 格式。
**防什么**：正则搜索 + 文件/目录路径处理。

### 18. Write File —— 防"新文件/自动建目录"回归
```
Create test/tmp/nested/hello.txt with 3 lines of content.
```
✅ 目录自动创建，返回 `Successfully wrote ... (3 lines)`。
**防什么**：mkdir -p、内容预览。

## Phase 6: 会话与 CLI（Test 14-16）

### 14. Session Resume —— 防"会话持久化/恢复"回归
第一会话：`Remember: secret code is BANANA-42` → exit。
第二会话：`--resume` → `What was the secret code?` → BANANA-42。
新会话：同样的提问 → 答不上。
**防什么**：--resume 恢复消息历史，跨进程记忆。

### 15. One-shot 模式 —— 防"单次执行后退出"回归
```
node src\cli.mjs --yolo "Read src/tools.mjs and tell me how many tools there are."
```
✅ 执行后自动退出；错误文件路径不 crash。
**防什么**：单次模式入口、错误是数据不是异常。

### 16. 预算控制 —— 防"无限循环烧钱"回归
```
node src\cli.mjs --yolo --max-turns 2 "Read package.json, tsconfig.json, src/agent.mjs, ... 读 5 个文件"
```
✅ 2 个 turn 后停止，输出 max turns reached，不会读完 5 个。
**防什么**：turn 上限、循环终止条件。

## Phase 7: 扩展系统（Test 19）

### 19. 自定义 Agent —— 防".claude/agents 发现"回归
`.claude/agents/reviewer.md` 定义一个 reviewer，然后：
```
Use the agent tool with type "reviewer" to review src/frontmatter.mjs
```
✅ 输出 `[sub-agent:reviewer]` 标记；受 allowed-tools 限制。
**防什么**：自定义 agent 发现、frontmatter、allowed-tools 白名单。

## Phase 8: 自治与续跑（Test 20-22）—— 我们的 v1 未含 ch15 自治，标注为延伸

> ch15（Auto Mode / /goal / /loop）不在本阶段范围（README Phase 2 只到 ch14）。
> 跑到 07 或以后再看。下方两条是本仓库已具备的替代验证：

### 20'. 看门狗回归（替代 /goal）—— 防"循环失控"回归
```
node src\cli.mjs --yolo --max-turns 3 "反复读同一个文件，直到成功"
```
✅ 3 个 turn 后停止，不无限循环。
**防什么**：turn 预算兜底（等价 s03 看门狗的思想）。

### 21'. 技能迭代（替代 /loop）—— 防"多轮工具编排"回归
```
/greet 张三，然后用 read_file 读 greeting.txt 对比。
```
✅ 技能 prompt 编排多轮工具调用。
**防什么**：技能 + 工具链的组合。

## Phase 9：08 产品化能力（A1-A8）

### A1. 一键 demo —— 防“README 跑不起来”回归

```powershell
node demo.mjs
```

✅ 不需要 API Key；依次看到 deny 决策、Skill 展开、mock Agent Loop 和 7 条 Trace。
**防什么**：工作目录、示例 Skill、mock 输入和 Trace 接线任意一处断裂。

### A2. 对象权限规则 —— 防“配置解析/原因丢失”回归

把 `.claude/settings.example.json` 复制为 `.claude/settings.json`，启动 REPL 后输入：

```text
/permissions
请执行 git push origin main
```

✅ 看到 allow/deny 数量；即使使用 `--yolo`，`git push*` 仍按配置拒绝，并显示自定义 reason。
**防什么**：对象规则、glob、deny 优先级、可解释拒绝。

### A3. 权限热刷新 —— 防“修改配置必须重启”回归

REPL 运行期间修改 `.claude/settings.json`，然后输入：

```text
/permissions refresh
```

✅ 规则数量立即更新，下一次工具判断使用新规则。
**防什么**：权限缓存无法失效。

### A4. Skills 元数据索引 —— 防“发现阶段加载全文”回归

```text
/skills
```

✅ 列出 `/review`、source、context 和 description，不输出 Skill 正文。
**防什么**：frontmatter 索引、用户/项目目录合并、正文泄漏到列表。

### A5. Skills 懒加载和刷新 —— 防“运行中技能不更新”回归

先执行 `/skills`，再编辑 `.claude/skills/review/SKILL.md` 正文并调用：

```text
/review src/trace.mjs
```

✅ 使用修改后的正文；新建另一个技能后，`/skills refresh` 能发现它。
**防什么**：正文被发现缓存、目录缓存无法刷新。

### A6. 当前会话 Trace —— 防“只有文件、没有查看入口”回归

完成一次普通任务后输入：

```text
/trace 20
```

✅ 看到同一 sessionId 下的 model、tool、permission 事件，序号递增且包含耗时。
**防什么**：事件未接入 Agent Loop、摘要读取错误、父子链路断开。

### A7. Trace 脱敏 —— 防“日志泄露密钥”回归

只使用假的测试值执行一个包含 `Bearer token-value-123` 和 `sk-secret123456` 的工具参数，然后检查 Trace。

✅ 原值不出现在 JSONL，替换为 `[REDACTED]`。
**防什么**：只按对象字段名脱敏，漏掉 command 字符串中的凭证。

### A8. 关闭 Trace —— 防“用户无法禁用落盘”回归

```powershell
node src\cli.mjs --mock --no-trace "读取 greeting.txt"
```

✅ Agent 正常完成；本次 session 不产生 Trace 文件。
**防什么**：可观测性变成强制副作用或写入失败拖垮主流程。

## 快速对照

| # | 功能 | 通过 | 防什么回归 |
|---|------|:---:|---|
| 1 | MCP | ☐ | 外部工具挂载/路由 |
| 2 | WebFetch | ☐ | HTTP/HTML 清洗 |
| 3 | 并行执行 | ☐ | 并发批次 |
| 4 | 记忆召回 | ☐ | 保存/预取/注入 |
| 5 | @include+Rules | ☐ | CLAUDE.md 加载 |
| 6 | read-before-edit | ☐ | 盲写覆盖 |
| 7 | 大结果持久化 | ☐ | 上下文撑爆 |
| 8 | Skill | ☐ | 技能发现/展开 |
| 9 | ToolSearch | ☐ | deferred 懒加载 |
| 10 | REPL 命令 | ☐ | 命令分发 |
| 11 | Sub-agent | ☐ | 子 Agent 隔离 |
| 12 | Plan Mode | ☐ | 只读/审批 |
| 13 | 引号规范化 | ☐ | 弯引号编辑 |
| 14 | Session Resume | ☐ | 会话恢复 |
| 15 | One-shot | ☐ | 单次执行 |
| 16 | 预算控制 | ☐ | 无限循环 |
| 17 | Grep Search | ☐ | 搜索 |
| 18 | Write File | ☐ | 新文件/建目录 |
| 19 | 自定义 Agent | ☐ | agents 发现 |
| A1 | 一键 demo | ☐ | README/演示链路 |
| A2 | 对象权限规则 | ☐ | 配置/原因/deny 优先 |
| A3 | 权限热刷新 | ☐ | 规则缓存失效 |
| A4 | Skills 元数据 | ☐ | 懒发现 |
| A5 | Skills 刷新 | ☐ | 正文/目录更新 |
| A6 | `/trace` | ☐ | 会话事件链 |
| A7 | Trace 脱敏 | ☐ | 凭证泄露 |
| A8 | `--no-trace` | ☐ | 可关闭落盘 |
