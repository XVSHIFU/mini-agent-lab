import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { createPermissionPolicy } from "../src/permissions.mjs";
import { SkillRegistry } from "../src/skills.mjs";
import { TraceRecorder } from "../src/trace.mjs";
import { Agent } from "../src/agent.mjs";
import { getGitContext } from "../src/prompt.mjs";

test("Git 上下文在非仓库目录静默回退", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-no-git-"));
  try {
    assert.equal(getGitContext(root), "");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("声明式 deny 规则在 bypassPermissions 模式下仍然优先", () => {
  const policy = createPermissionPolicy({
    deny: [{
      tool: "run_shell",
      pattern: "git push*",
      reason: "发布操作必须由用户亲自执行",
    }],
  });

  const decision = policy.evaluate(
    "run_shell",
    { command: "git push origin main" },
    { mode: "bypassPermissions" },
  );

  assert.equal(decision.action, "deny");
  assert.equal(decision.reasonCode, "rule_deny");
  assert.equal(decision.message, "发布操作必须由用户亲自执行");
  assert.equal(decision.matchedRule.pattern, "git push*");
});

test("声明式 allow 规则可以放行匹配的危险命令", () => {
  const policy = createPermissionPolicy({
    allow: [{
      tool: "run_shell",
      pattern: "git push origin sandbox*",
      reason: "沙盒远端允许自动推送",
    }],
  });

  const decision = policy.evaluate(
    "run_shell",
    { command: "git push origin sandbox/demo" },
    { mode: "default" },
  );

  assert.equal(decision.action, "allow");
  assert.equal(decision.reasonCode, "rule_allow");
  assert.equal(decision.message, "沙盒远端允许自动推送");
});

test("Skills 发现阶段只返回元数据，调用时才读取最新正文", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-skills-"));
  const skillDir = path.join(root, "project", "deploy");
  const skillFile = path.join(skillDir, "SKILL.md");
  fs.mkdirSync(skillDir, { recursive: true });

  try {
    fs.writeFileSync(skillFile, "---\nname: deploy\ndescription: 部署演示\n---\n旧正文 $ARGUMENTS");
    const registry = new SkillRegistry({
      userDir: path.join(root, "user"),
      projectDir: path.join(root, "project"),
    });

    const [descriptor] = registry.list();
    assert.equal(descriptor.name, "deploy");
    assert.equal("promptTemplate" in descriptor, false);

    fs.writeFileSync(skillFile, "---\nname: deploy\ndescription: 部署演示\n---\n最新正文 $ARGUMENTS");
    assert.equal(registry.resolve("/deploy sandbox"), "最新正文 sandbox");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Skills refresh 可以发现运行期间新增的技能", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-skills-refresh-"));
  const projectDir = path.join(root, "project");
  const registry = new SkillRegistry({ userDir: path.join(root, "user"), projectDir });

  try {
    assert.deepEqual(registry.list(), []);
    const skillDir = path.join(projectDir, "review");
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: review\ndescription: 复查改动\n---\n检查 $ARGUMENTS",
    );

    registry.refresh();
    assert.equal(registry.list().some((skill) => skill.name === "review"), true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace 以有序 JSONL 记录事件并自动隐藏敏感字段", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-trace-"));
  try {
    const trace = new TraceRecorder({
      sessionId: "ses_test",
      dir: root,
      clock: () => new Date("2026-08-22T00:00:00.000Z"),
    });

    trace.record("model.request", { model: "demo", apiKey: "sk-secret" });
    trace.record("tool.completed", {
      tool: "web_fetch",
      headers: { authorization: "Bearer hidden" },
    });

    const events = trace.recent(10);
    assert.deepEqual(events.map((event) => event.seq), [1, 2]);
    assert.equal(events[0].data.apiKey, "[REDACTED]");
    assert.equal(events[1].data.headers.authorization, "[REDACTED]");
    assert.equal(events[1].type, "tool.completed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent 把权限拒绝写入当前会话 Trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-agent-trace-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_permission", dir: root });
    const agent = new Agent({
      mock: true,
      permissionMode: "dontAsk",
      traceRecorder: trace,
      permissionPolicy: createPermissionPolicy(),
    });

    const output = await agent.executeToolCall("run_shell", { command: "git push origin main" });
    const decision = trace.recent(20).find((event) => event.type === "permission.decision");

    assert.match(output, /Action denied/);
    assert.equal(decision.data.tool, "run_shell");
    assert.equal(decision.data.action, "deny");
    assert.equal(decision.data.reasonCode, "confirmation_auto_denied");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent 为成功工具调用记录开始、完成和耗时", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-tool-trace-"));
  const target = path.join(root, "hello.txt");
  fs.writeFileSync(target, "hello trace");
  try {
    const trace = new TraceRecorder({ sessionId: "ses_tool", dir: root });
    const agent = new Agent({ mock: true, traceRecorder: trace });

    const output = await agent.executeToolCall("read_file", { file_path: target });
    const events = trace.recent(20);
    const started = events.find((event) => event.type === "tool.started");
    const completed = events.find((event) => event.type === "tool.completed");

    assert.match(output, /hello trace/);
    assert.equal(started.data.tool, "read_file");
    assert.equal(completed.data.status, "ok");
    assert.equal(typeof completed.data.durationMs, "number");
    assert.equal(completed.data.outputBytes > 0, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent Loop 记录模型请求、响应、工具数量和耗时", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-model-trace-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_model", dir: root });
    const agent = new Agent({
      mock: true,
      isSubAgent: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
    });

    await agent.runOnce("读取 greeting.txt");
    const events = trace.recent(50);
    const requests = events.filter((event) => event.type === "model.request");
    const responses = events.filter((event) => event.type === "model.response");

    assert.equal(requests.length, 2);
    assert.equal(responses.length, 2);
    assert.equal(responses[0].data.toolCalls, 1);
    assert.equal(typeof responses[0].data.durationMs, "number");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("模型响应 Trace 包含本次调用的估算成本", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-cost-trace-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_cost", dir: root });
    const agent = new Agent({
      mock: true,
      isSubAgent: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
    });
    agent.callModel = async function callModelWithUsage() {
      this.lastUsage = { prompt_tokens: 1_000_000, completion_tokens: 500_000 };
      return { role: "assistant", content: "done" };
    };

    await agent.runOnce("计算成本");
    const response = trace.recent(10).find((event) => event.type === "model.response");

    assert.deepEqual(response.data.usage, { prompt_tokens: 1_000_000, completion_tokens: 500_000 });
    assert.equal(response.data.estimatedCostCny, 6);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace 摘要只展示最近事件并给出日志路径", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-trace-summary-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_summary", dir: root });
    trace.record("model.request", { model: "demo" });
    trace.record("tool.completed", { tool: "read_file", status: "ok" });

    const summary = trace.formatRecent(1);
    assert.match(summary, /trace-ses_summary\.jsonl/);
    assert.doesNotMatch(summary, /model\.request/);
    assert.match(summary, /#2 tool\.completed/);
    assert.match(summary, /read_file/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace 也会隐藏普通字符串中的 Bearer token 和 sk key", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-trace-redact-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_redact", dir: root });
    trace.record("tool.started", {
      tool: "run_shell",
      args: { command: "curl -H 'Authorization: Bearer token-value-123' -d api_key=sk-secret123456" },
    });

    const serialized = JSON.stringify(trace.recent(1)[0]);
    assert.doesNotMatch(serialized, /token-value-123|sk-secret123456/);
    assert.match(serialized, /\[REDACTED\]/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Trace 保留 token 用量，但继续隐藏真正的访问令牌", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-trace-usage-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_usage", dir: root });
    trace.record("model.response", {
      usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      access_token: "private-token",
      auth_token: "private-auth-token",
      id_token: "private-id-token",
      session_token: "private-session-token",
    });

    const [event] = trace.recent(1);
    assert.deepEqual(event.data.usage, {
      prompt_tokens: 120,
      completion_tokens: 30,
      total_tokens: 150,
    });
    assert.equal(event.data.access_token, "[REDACTED]");
    assert.equal(event.data.auth_token, "[REDACTED]");
    assert.equal(event.data.id_token, "[REDACTED]");
    assert.equal(event.data.session_token, "[REDACTED]");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Agent 通过注入的 Skills 注册表执行技能并记录激活事件", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-skill-trace-"));
  const projectDir = path.join(root, "skills");
  const skillDir = path.join(projectDir, "review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: review\ndescription: 复查代码\nallowed-tools: read_file, grep_search\n---\n复查 $ARGUMENTS",
  );

  try {
    const registry = new SkillRegistry({ userDir: path.join(root, "user"), projectDir });
    const trace = new TraceRecorder({ sessionId: "ses_skill", dir: root });
    const agent = new Agent({
      mock: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
      skillRegistry: registry,
    });

    const output = await agent.executeToolCall("skill", { skill_name: "review", args: "src" });
    const activated = trace.recent(20).find((event) => event.type === "skill.activated");

    assert.match(output, /复查 src/);
    assert.equal(activated.data.skill, "review");
    assert.equal(activated.data.context, "inline");
    assert.deepEqual(activated.data.allowedTools, ["read_file", "grep_search"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Sub-Agent fork-return 与父 Agent 共用会话 Trace", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-subagent-trace-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_subagent", dir: root });
    const agent = new Agent({
      mock: true,
      maxOutputTokens: 12_345,
      customSystemPrompt: "test",
      traceRecorder: trace,
    });

    const output = await agent.executeToolCall("agent", {
      type: "explore",
      description: "读取问候文件",
      prompt: "读取 greeting.txt",
    });
    const events = trace.recent(100);
    const started = events.find((event) => event.type === "subagent.started");
    const childRequest = events.find(
      (event) => event.type === "model.request" && event.data.isSubAgent === true,
    );

    assert.match(output, /greeting\.txt/);
    assert.match(started.data.childAgentId, /^agt_/);
    assert.equal(events.some((event) => event.type === "subagent.completed"), true);
    assert.equal(childRequest.data.agentId, started.data.childAgentId);
    assert.equal(childRequest.data.parentAgentId, agent.agentId);
    assert.equal(childRequest.data.maxOutputTokens, 12_345);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Plan 模式会在调用前阻止未知副作用的 MCP 工具", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-mcp-permission-"));
  try {
    let called = false;
    const trace = new TraceRecorder({ sessionId: "ses_mcp_plan", dir: root });
    const agent = new Agent({
      mock: true,
      permissionMode: "plan",
      customSystemPrompt: "test",
      traceRecorder: trace,
    });
    agent.mcpManager = {
      isMcpTool: () => true,
      callTool: async () => { called = true; return "unexpected"; },
    };

    const output = await agent.executeToolCall("mcp__demo__write", { value: "x" });
    const decision = trace.recent(20).find((event) => event.type === "permission.decision");

    assert.equal(called, false);
    assert.match(output, /Action denied/);
    assert.equal(decision.data.reasonCode, "plan_mcp_blocked");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("显式 deny 规则可以在 fork 前阻止 agent 工具", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-agent-permission-"));
  try {
    const trace = new TraceRecorder({ sessionId: "ses_agent_deny", dir: root });
    const permissionPolicy = createPermissionPolicy({
      deny: [{ tool: "agent", reason: "当前项目禁止派生子 Agent" }],
    });
    const agent = new Agent({
      mock: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
      permissionPolicy,
    });

    const output = await agent.executeToolCall("agent", {
      type: "explore",
      description: "不应启动",
      prompt: "读取 greeting.txt",
    });

    assert.match(output, /当前项目禁止派生子 Agent/);
    assert.equal(trace.recent(20).some((event) => event.type === "subagent.started"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("用户手动调用 context: fork 的 Skill 时不会污染父 Agent 历史", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-user-fork-skill-"));
  const projectDir = path.join(root, "skills");
  const skillDir = path.join(projectDir, "fork-review");
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(
    path.join(skillDir, "SKILL.md"),
    "---\nname: fork-review\ndescription: 隔离复查\ncontext: fork\nallowed-tools: read_file\n---\n读取并复查 $ARGUMENTS",
  );

  try {
    const registry = new SkillRegistry({ userDir: path.join(root, "user"), projectDir });
    const trace = new TraceRecorder({ sessionId: "ses_user_fork", dir: root });
    const agent = new Agent({
      mock: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
      skillRegistry: registry,
    });
    const invocation = registry.resolveInvocation("/fork-review greeting.txt");

    const output = await agent.runUserSkill(invocation);

    assert.equal(invocation.context, "fork");
    assert.match(output, /greeting\.txt/);
    assert.deepEqual(agent.history(), []);
    assert.equal(
      trace.recent(50).some((event) => event.type === "skill.activated" && event.data.context === "fork"),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Plan 选项 1 清空旧上下文后仍用合法消息执行已批准计划", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-plan-clear-"));
  const plan = "# 已批准计划\n\n在 examples/task-board 中实现任务看板。";

  try {
    const agent = new Agent({
      mock: true,
      permissionMode: "plan",
      customSystemPrompt: "test",
      traceEnabled: false,
    });
    agent.planFilePath = path.join(root, "approved-plan.md");
    fs.writeFileSync(agent.planFilePath, plan);
    agent.planApprovalFn = async () => ({ choice: "clear-and-execute" });

    let modelCalls = 0;
    agent.callModel = async function validatingModelBoundary() {
      modelCalls++;
      const messages = this.buildMessages();
      const pendingToolCalls = new Set();

      for (const message of messages) {
        if (message.role === "assistant") {
          for (const call of message.tool_calls ?? []) pendingToolCalls.add(call.id);
        }
        if (message.role === "tool" && !pendingToolCalls.delete(message.tool_call_id)) {
          throw new Error(
            "API 400: Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
          );
        }
      }

      if (modelCalls === 1) {
        return {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_exit_plan",
            type: "function",
            function: { name: "exit_plan_mode", arguments: "{}" },
          }],
        };
      }

      assert.equal(
        messages.some((message) => message.role === "user" && message.content?.includes(plan)),
        true,
        "fresh execution context should retain the approved plan",
      );
      return { role: "assistant", content: "开始执行已批准计划。" };
    };

    await agent.chat("请先规划任务看板");

    assert.equal(modelCalls, 2);
    assert.equal(agent.permissionMode, "acceptEdits");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("模型在推理阶段耗尽输出额度时自动续跑而不是静默结束", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-length-retry-"));

  try {
    const trace = new TraceRecorder({ sessionId: "ses_length_retry", dir: root });
    const agent = new Agent({
      mock: true,
      customSystemPrompt: "test",
      traceRecorder: trace,
    });
    let modelCalls = 0;
    agent.callModel = async function lengthThenSuccessModel() {
      modelCalls++;
      if (modelCalls === 1) {
        this.lastFinishReason = "length";
        this.lastUsage = {
          prompt_tokens: 19_707,
          completion_tokens: 4_096,
          total_tokens: 23_803,
          completion_tokens_details: { reasoning_tokens: 4_096 },
        };
        return { role: "assistant", content: null };
      }

      this.lastFinishReason = "stop";
      this.lastUsage = { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 };
      return { role: "assistant", content: "继续执行任务。" };
    };

    await agent.chat("实现任务看板");

    assert.equal(modelCalls, 2);
    assert.equal(agent.history().at(-1)?.content, "继续执行任务。");
    assert.equal(
      trace.recent(20).some((event) =>
        event.type === "model.continuation" && event.data.finishReason === "length"),
      true,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("模型适配器发送可配置输出上限并保留流式终止原因", async () => {
  const originalFetch = globalThis.fetch;
  let requestBody;

  try {
    globalThis.fetch = async (_url, init) => {
      requestBody = JSON.parse(init.body);
      const stream = [
        'data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking"},"finish_reason":null}]}',
        'data: {"choices":[{"index":0,"delta":{"content":""},"finish_reason":"length"}],"usage":{"prompt_tokens":19707,"completion_tokens":4096,"total_tokens":23803,"completion_tokens_details":{"reasoning_tokens":4096}}}',
        "data: [DONE]",
        "",
      ].join("\n");
      return new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    };

    const agent = new Agent({
      apiKey: "test-key",
      baseUrl: "https://api.example.test/v1",
      maxOutputTokens: 32_768,
      customSystemPrompt: "test",
      traceEnabled: false,
    });

    const reply = await agent.callModel();

    assert.equal(requestBody.max_tokens, 32_768);
    assert.equal(agent.lastFinishReason, "length");
    assert.equal(agent.lastUsage.completion_tokens_details.reasoning_tokens, 4_096);
    assert.equal(reply.content, null);
    assert.equal(reply.tool_calls, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("CLI 帮助公开模型输出上限参数和环境变量", () => {
  const cliPath = fileURLToPath(new URL("../src/cli.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [cliPath, "--help"], { encoding: "utf-8" });

  assert.match(output, /--max-tokens <n>/);
  assert.match(output, /AGENT_MAX_TOKENS/);
});

test("REPL 权限确认一次输入只回显一个 y", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-confirm-tty-"));
  const target = path.join(root, "confirmed.txt");
  const agentUrl = new URL("../src/agent.mjs", import.meta.url).href;
  const script = `
    import { createInterface } from "node:readline";
    import { Agent } from ${JSON.stringify(agentUrl)};

    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    Object.defineProperty(process.stdout, "columns", { value: 80, configurable: true });
    process.stdin.setRawMode = () => {};

    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const agent = new Agent({
      mock: true,
      customSystemPrompt: "test",
      traceEnabled: false,
      confirmPermission: () => new Promise((resolve) => {
        rl.question("  Allow? (y/n): ", (answer) =>
          resolve(answer.trim().toLowerCase().startsWith("y")));
      }),
      permissionPolicy: {
        evaluate: () => ({ action: "confirm", message: "write demo file" }),
      },
    });

    await agent.executeToolCall("write_file", {
      file_path: ${JSON.stringify(target)},
      content: "confirmed",
    });
    rl.close();
  `;

  try {
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
      input: "y\r",
      encoding: "utf-8",
      timeout: 5_000,
    });
    const plain = output.replace(/\x1b\[[0-9;]*m/g, "");

    assert.match(plain, /Allow\? \(y\/n\): y\r?\n/);
    assert.doesNotMatch(plain, /Allow\? \(y\/n\): yy/);
    assert.equal(fs.readFileSync(target, "utf-8"), "confirmed");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
