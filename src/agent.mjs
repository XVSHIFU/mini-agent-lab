// ============================================================================
// 06 · Agent（ch1-9 基础 + ch10 Plan Mode + ch11 子 Agent + ch12 MCP）
// ============================================================================
// 单 Agent 收尾 + 工程化收口：
//   · ch10 Plan Mode：只读规划 + plan 文件白名单 + 四选一审批
//   · ch11 子 Agent：agent 工具 fork-return，explore/plan/general + 自定义
//   · ch12 MCP：外部工具动态挂载，mcp__server__tool 透明路由
// ============================================================================

import { createInterface } from "node:readline";
import { mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { executeTool, createToolRegistrar, CONCURRENCY_SAFE_TOOLS } from "./tools.mjs";
import { buildSystemPrompt, buildUserContextReminder } from "./prompt.mjs";
import { checkPermission } from "./permissions.mjs";
import { persistLargeResult, runCompressionPipeline, maybeCompact, KEEP_RECENT, COMPACT_THRESHOLD } from "./context.mjs";
import { recallMemories, startMemoryPrefetch, formatMemoriesForInjection, getMemoryDir } from "./memory.mjs";
import { executeSkill } from "./skills.mjs";
import { getSubAgentConfig } from "./subagent.mjs";
import { McpManager } from "./mcp.mjs";
import { saveSession } from "./session.mjs";
import { TraceRecorder } from "./trace.mjs";
import { printToolCall, printToolResult, printInfo, printSubAgentStart, printSubAgentEnd } from "./ui.mjs";

const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
const SUMMARY_PROMPT = `你的任务是把一段即将被丢弃的对话压缩成结构化摘要。
必须包含：1.任务目标（逐字引用用户原话）；2.已完成；3.未完成/待办；4.涉及的文件与关键命令（逐字）；5.关键决定与踩过的坑。只输出纯文本。`;
const DEFAULT_PRICING_CNY_PER_MILLION = { input: 2.0, output: 8.0 };
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;
const MAX_EMPTY_LENGTH_RETRIES = 2;
const LENGTH_CONTINUATION_PROMPT =
  "The previous response reached its output limit before producing visible content or a tool call. Continue the current task now. Prefer the next concrete tool call; do not repeat completed exploration or planning.";

export function estimateUsageCostCny(usage, pricing = DEFAULT_PRICING_CNY_PER_MILLION) {
  if (!usage) return null;
  const promptTokens = usage.prompt_tokens ?? usage.prompt ?? 0;
  const completionTokens = usage.completion_tokens ?? usage.completion ?? 0;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1e6;
}

function isRetryable(error) {
  const status = error?.status || error?.statusCode;
  if ([429, 503, 529].includes(status)) return true;
  if (error?.code === "ECONNRESET" || error?.code === "ETIMEDOUT") return true;
  if ((error?.message || "").includes("overloaded")) return true;
  return false;
}

async function withRetry(fn, signal, maxRetries = 3) {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(signal); }
    catch (error) {
      if (signal?.aborted) throw error;
      if (attempt >= maxRetries || !isRetryable(error)) throw error;
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      const reason = error?.status ? `HTTP ${error.status}` : error?.code || "network error";
      printInfo(`(retrying after ${reason}… attempt ${attempt + 1}/${maxRetries})`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

export class Agent {
  constructor({
    model = "deepseek-v4-flash", apiKey, baseUrl = "https://api.deepseek.com/v1",
    permissionMode = "default", maxTurns, mock = false, effectiveWindow = 64_000,
    maxOutputTokens = DEFAULT_MAX_OUTPUT_TOKENS,
    isSubAgent = false,
    customSystemPrompt,   // ch11：子 Agent 的专用 system prompt
    customTools,          // ch11：子 Agent 的工具白名单
    planApprovalFn,       // ch10：审批回调（CLI 注入，子 Agent 无则直接退出）
    confirmPermission,    // ch6：权限确认回调（REPL 注入以复用同一个 readline）
    traceRecorder, traceEnabled = true, traceDir,
    skillRegistry,
    agentId, parentAgentId,
    permissionPolicy,
  } = {}) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.permissionMode = permissionMode;
    this.maxTurns = maxTurns;
    this.mock = mock;
    this.effectiveWindow = effectiveWindow;
    this.maxOutputTokens = Number.isSafeInteger(maxOutputTokens) && maxOutputTokens > 0
      ? maxOutputTokens
      : DEFAULT_MAX_OUTPUT_TOKENS;
    this.isSubAgent = isSubAgent;
    this.planApprovalFn = planApprovalFn;
    this.confirmPermission = confirmPermission;

    this.messages = [];
    this.readFileState = new Map();
    this.registrar = createToolRegistrar();
    this.isProcessing = false;
    this.controller = null;
    this.sessionId = `ses_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.agentId = agentId || `agt_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
    this.parentAgentId = parentAgentId || null;
    this.trace = traceRecorder || new TraceRecorder({
      sessionId: this.sessionId,
      enabled: traceEnabled,
      dir: traceDir,
    });
    this.skillRegistry = skillRegistry || { execute: executeSkill };
    this.permissionPolicy = permissionPolicy || {
      evaluate: (toolName, input, { mode, planFilePath } = {}) =>
        checkPermission(toolName, input, mode, planFilePath),
    };
    this.turnCount = 0;
    this.usageTotals = { prompt: 0, completion: 0 };

    // ch11：子 Agent 输出收集（null=主 Agent 直接打印，[]=子 Agent 收集）
    this.outputBuffer = null;
    // ch10：Plan Mode 状态
    this.prePlanMode = null;
    this.planFilePath = null;
    this.pendingContextReset = null;
    // system prompt 基础版（进入 plan 时在其后追加 plan 提示）
    this.usesDefaultSystemPrompt = !customSystemPrompt;
    this.baseSystemPrompt = customSystemPrompt || buildSystemPrompt();
    this.customTools = customTools; // ch11
    // ch12：MCP
    this.mcpManager = null;
    // ch6：会话白名单
    this.confirmedPaths = new Set();
    // ch7：上下文追踪
    this.lastApiCallTime = null;
    this.lastInputTokenCount = 0;
    // ch8：记忆追踪
    this.alreadySurfacedMemories = new Set();
    this.sessionMemoryBytes = 0;

    // ch10：--plan 启动时（CLI 直接设 permissionMode，不走 togglePlanMode）
    // 也要初始化 plan 状态，否则 planFilePath 是 null、模型没法写 plan 文件
    if (this.permissionMode === "plan") {
      this.prePlanMode = "default";
      this.planFilePath = this.generatePlanFilePath();
    }
  }

  // ─── 请求构建 ───────────────────────────────────────────────────────────
  buildMessages() {
    // 当前 system prompt = 基础 + plan 提示（若在 plan mode）
    const system = this.baseSystemPrompt + (this.permissionMode === "plan" ? this.buildPlanModePrompt() : "");
    const reminder = buildUserContextReminder();
    const msgs = [];
    let injected = false;
    for (const m of this.messages) {
      if (!injected && m.role === "user" && reminder) {
        msgs.push({ ...m, content: `${reminder}\n\n${m.content}` });
        injected = true;
      } else {
        msgs.push(m);
      }
    }
    return [{ role: "system", content: system }, ...msgs];
  }

  getActiveTools() {
    // 注意：plan 模式也返回全部工具（含 write_file/edit_file）——
    // 模型得能看到它们才能写 plan 文件；只读约束由权限闸强制（ch10），
    // 而不是从工具列表里藏起来（否则模型连 plan 文件都写不了）。
    let tools = this.customTools || this.registrar.getActiveToolDefinitions();
    // ch12：合并 MCP 工具（mcp__ 前缀）
    if (this.mcpManager) tools = [...tools, ...this.mcpManager.getToolDefinitions()];
    return tools;
  }

  // ch12：首次 chat 时懒连接 MCP（主 Agent 专属，子 Agent 不连）
  async ensureMcp() {
    if (this.isSubAgent || this.mock || this.mcpManager) return;
    this.mcpManager = new McpManager();
    try { await this.mcpManager.loadAndConnect(); }
    catch (err) { printInfo(`[mcp] init failed: ${err.message}`); }
  }

  // ─── 模型调用（ch5 流式 + 重试）────────────────────────────────────────
  async callModel() {
    if (this.mock) return this.mockResponse();
    return withRetry(async (signal) => {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: this.buildMessages(),
          tools: this.getActiveTools(),
          max_tokens: this.maxOutputTokens,
          stream: true,
          stream_options: { include_usage: true },
        }),
        signal,
      });
      if (!res.ok) throw new Error(`API ${res.status}: ${await res.text()}`);
      return await this.readSSE(res.body);
    }, this.controller?.signal);
  }

  async readSSE(body) {
    const decoder = new TextDecoder();
    let buffer = "", content = "";
    const toolCalls = new Map();
    let usage;
    let finishReason = null;
    let firstText = true;
    const emit = (t) => { if (firstText) { this.emitText("\n"); firstText = false; } this.emitText(t); };

    for await (const chunk of body) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, "");
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") break;
        let event;
        try { event = JSON.parse(payload); } catch { continue; }
        if (event.usage) usage = event.usage;
        const choice = event.choices?.[0];
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        const delta = choice?.delta;
        if (!delta) continue;
        if (delta.content) { emit(delta.content); content += delta.content; }
        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const slot = toolCalls.get(tc.index) ?? { id: "", name: "", arguments: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.arguments += tc.function.arguments;
            toolCalls.set(tc.index, slot);
          }
        }
      }
    }
    const calls = toolCalls.size > 0
      ? [...toolCalls.entries()].sort(([a], [b]) => a - b).map(([, tc]) => ({
          id: tc.id, type: "function", function: { name: tc.name, arguments: tc.arguments },
        }))
      : undefined;
    this.lastUsage = usage;
    this.lastFinishReason = finishReason;
    if (usage) {
      this.lastInputTokenCount = (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0);
      this.accumulateUsage(usage);
    }
    this.lastApiCallTime = Date.now();
    return { role: "assistant", content: content || null, tool_calls: calls };
  }

  mockResponse() {
    const called = this.messages.filter((m) => m.role === "tool");
    if (called.length === 0) {
      return { role: "assistant", content: "", tool_calls: [{
        id: "call_mock_read", type: "function",
        function: { name: "read_file", arguments: JSON.stringify({ file_path: "greeting.txt" }) },
      }] };
    }
    const line = called[0].content.split("\n").find((l) => l.split("|").slice(1).join("|").trim().length > 0);
    const text = (line ?? "").split("|").slice(1).join("|").trim();
    return { role: "assistant", content: `greeting.txt 的内容是：${text || "(空)"}` };
  }

  // ch11：主 Agent 直接打印，子 Agent 收集进 buffer
  emitText(text) {
    if (this.outputBuffer) this.outputBuffer.push(text);
    else process.stdout.write(text);
  }

  recordTrace(type, data = {}) {
    return this.trace.record(type, {
      agentId: this.agentId,
      parentAgentId: this.parentAgentId,
      ...data,
    });
  }

  // ─── ch1 心脏：Agent Loop ───────────────────────────────────────────────
  async chat(userText) {
    this.messages.push({ role: "user", content: userText });
    this.isProcessing = true;
    this.controller = new AbortController();
    await this.ensureMcp(); // ch12：首次 chat 连 MCP

    let memoryPrefetch = null;
    if (!this.isSubAgent && !this.mock) {
      memoryPrefetch = startMemoryPrefetch(userText, this.buildSideQuery(), this.alreadySurfacedMemories, this.sessionMemoryBytes);
    }
    if (!this.mock) {
      this.messages = await maybeCompact(this.messages, (t) => this.summarize(t));
    }

    let emptyLengthRetries = 0;
    try {
      while (true) {
        if (this.maxTurns && this.turnCount >= this.maxTurns) { console.log("\n(max turns reached)"); return; }
        this.turnCount++;

        if (!this.mock) {
          const utilization = this.effectiveWindow ? this.lastInputTokenCount / this.effectiveWindow : 0;
          runCompressionPipeline(this.messages, { utilization, lastApiCallTime: this.lastApiCallTime });
        }
        if (memoryPrefetch && memoryPrefetch.settled && !memoryPrefetch.consumed) {
          memoryPrefetch.consumed = true;
          const memories = await memoryPrefetch.promise;
          if (memories.length > 0) {
            this.messages.push({ role: "user", content: formatMemoriesForInjection(memories) });
            for (const m of memories) { this.alreadySurfacedMemories.add(m.path); this.sessionMemoryBytes += Buffer.byteLength(m.content); }
          }
        }

        const modelStartedAt = performance.now();
        this.lastUsage = null;
        this.lastFinishReason = null;
        const modelSpanId = `mdl_${this.agentId}_${this.turnCount}`;
        this.recordTrace("model.request", {
          spanId: modelSpanId,
          turn: this.turnCount,
          model: this.model,
          maxOutputTokens: this.maxOutputTokens,
          messageCount: this.messages.length,
          toolCount: this.getActiveTools().length,
          isSubAgent: this.isSubAgent,
        });
        let reply;
        try {
          reply = await this.callModel();
          this.recordTrace("model.response", {
            spanId: modelSpanId,
            turn: this.turnCount,
            durationMs: Math.round((performance.now() - modelStartedAt) * 100) / 100,
            toolCalls: reply.tool_calls?.length ?? 0,
            contentBytes: Buffer.byteLength(String(reply.content ?? "")),
            finishReason: this.lastFinishReason,
            usage: this.lastUsage,
            estimatedCostCny: estimateUsageCostCny(this.lastUsage),
          });
        } catch (error) {
          this.recordTrace("model.failed", {
            spanId: modelSpanId,
            turn: this.turnCount,
            durationMs: Math.round((performance.now() - modelStartedAt) * 100) / 100,
            error: error.message,
          });
          throw error;
        }
        const toolCalls = reply.tool_calls ?? [];
        const hasVisibleContent = Boolean(String(reply.content ?? "").trim());
        if (!hasVisibleContent && toolCalls.length === 0 && this.lastFinishReason === "length") {
          if (emptyLengthRetries >= MAX_EMPTY_LENGTH_RETRIES) {
            throw new Error(
              `Model reached the output limit ${MAX_EMPTY_LENGTH_RETRIES + 1} times without producing content or a tool call.`,
            );
          }
          emptyLengthRetries++;
          this.recordTrace("model.continuation", {
            spanId: modelSpanId,
            finishReason: this.lastFinishReason,
            attempt: emptyLengthRetries,
            maxRetries: MAX_EMPTY_LENGTH_RETRIES,
          });
          printInfo(`(model output limit reached; continuing ${emptyLengthRetries}/${MAX_EMPTY_LENGTH_RETRIES})`);
          this.messages.push({ role: "user", content: LENGTH_CONTINUATION_PROMPT });
          continue;
        }
        emptyLengthRetries = 0;
        if (reply.content) this.emitText(reply.content);
        this.emitText("\n");
        this.messages.push(reply);

        if (toolCalls.length === 0) return;

        // ch5：并发安全工具并行，其余串行
        const batches = [];
        for (const call of toolCalls) {
          const safe = CONCURRENCY_SAFE_TOOLS.has(call.function?.name);
          if (safe && batches.length > 0 && batches[batches.length - 1].concurrent) batches[batches.length - 1].items.push(call);
          else batches.push({ concurrent: safe, items: [call] });
        }
        const results = [];
        for (const batch of batches) {
          const executed = await Promise.all(batch.items.map(async (call) => {
            let args = {};
            try { args = JSON.parse(call.function?.arguments || "{}"); } catch {}
            return { call, output: await this.executeToolCall(call.function?.name, args) };
          }));
          for (const { call, output } of executed) results.push({ role: "tool", tool_call_id: call.id, content: output });
        }
        this.messages.push(...results);
        if (this.pendingContextReset) {
          this.messages = [{ role: "user", content: this.pendingContextReset }];
          this.pendingContextReset = null;
        }
        if (!this.isSubAgent) this.autoSave();
      }
    } finally {
      this.isProcessing = false;
      this.controller = null;
    }
  }

  // ─── ch6 权限闸 + ch10 plan 工具 + ch11 agent + ch12 mcp ───────────────
  async executeToolCall(name, args) {
    const startedAt = performance.now();
    const toolSpanId = `tool_${this.agentId}_${this.turnCount}_${Math.random().toString(36).slice(2, 6)}`;
    this.recordTrace("tool.started", { spanId: toolSpanId, tool: name, args });
    const finishTool = (output, status = "ok") => {
      this.recordTrace("tool.completed", {
        spanId: toolSpanId,
        tool: name,
        status,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        outputBytes: Buffer.byteLength(String(output ?? "")),
      });
      return output;
    };

    // ch10：plan 模式切换工具（走 Agent 内部状态，不能走无状态分发）
    if (name === "enter_plan_mode" || name === "exit_plan_mode") {
      return finishTool(await this.executePlanModeTool(name));
    }
    const perm = this.permissionPolicy.evaluate(name, args, {
      mode: this.permissionMode,
      planFilePath: this.planFilePath,
    });
    this.recordTrace("permission.decision", {
      spanId: toolSpanId,
      tool: name,
      mode: this.permissionMode,
      action: perm.action,
      reasonCode: perm.reasonCode,
      message: perm.message,
      matchedRule: perm.matchedRule,
    });
    if (perm.action === "deny") {
      printInfo(`Denied: ${perm.message}`);
      return finishTool(`Action denied: ${perm.message}`, "denied");
    }
    if (perm.action === "confirm" && perm.message && !this.confirmedPaths.has(perm.message)) {
      const ok = await this.confirmDangerous(perm.message);
      this.recordTrace("permission.user_decision", { spanId: toolSpanId, tool: name, allowed: ok, message: perm.message });
      if (!ok) return finishTool("User denied this action.", "denied");
      this.confirmedPaths.add(perm.message);
    }
    // ch11：agent 工具也经过统一权限闸；plan 子 Agent 继续继承只读模式
    if (name === "agent") {
      return finishTool(await this.executeAgentTool(args));
    }
    // ch12：MCP 工具在调用外部服务器前经过统一权限闸
    if (this.mcpManager?.isMcpTool(name)) {
      printToolCall(name, args);
      try {
        const out = await this.mcpManager.callTool(name, args);
        printToolResult(name, out);
        return finishTool(out);
      } catch (err) {
        return finishTool(`MCP 工具调用失败：${err.message}`, "error");
      }
    }
    if (name === "skill") {
      const skill = this.skillRegistry.execute(args.skill_name, args.args || "");
      if (!skill) return finishTool(`Unknown skill: ${args.skill_name}`, "not_found");
      this.recordTrace("skill.activated", {
        spanId: toolSpanId,
        skill: args.skill_name,
        context: skill.context,
        allowedTools: skill.allowedTools,
      });
      if (skill.context === "fork") {
        return finishTool(await this.runForkedSkill(skill, args.skill_name));
      }
      return finishTool(`[Skill "${args.skill_name}" activated]\n\n${skill.prompt}`);
    }

    printToolCall(name, args);
    try {
      let output = await executeTool(name, args, {
        readFileState: this.readFileState, permissionMode: this.permissionMode, registrar: this.registrar,
      });
      output = persistLargeResult(name, output);
      printToolResult(name, output);
      return finishTool(output);
    } catch (error) {
      this.recordTrace("tool.failed", {
        spanId: toolSpanId,
        tool: name,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
        error: error.message,
      });
      throw error;
    }
  }

  async runForkedSkill(skill, skillName = "unknown") {
    const allowedNames = skill.allowedTools ? new Set(skill.allowedTools) : null;
    const customTools = allowedNames
      ? this.registrar.getActiveToolDefinitions().filter((tool) => allowedNames.has(tool.function.name))
      : undefined;
    const sub = new Agent({
      model: this.model,
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      maxOutputTokens: this.maxOutputTokens,
      permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
      isSubAgent: true,
      mock: this.mock,
      customTools,
      traceRecorder: this.trace,
      skillRegistry: this.skillRegistry,
      parentAgentId: this.agentId,
      permissionPolicy: this.permissionPolicy,
    });
    const spanId = `skill_${this.agentId}_${Math.random().toString(36).slice(2, 6)}`;
    this.recordTrace("skill.fork_started", { spanId, skill: skillName, childAgentId: sub.agentId });
    try {
      const result = await sub.runOnce(`按技能执行：\n${skill.prompt}`);
      this.recordTrace("skill.fork_completed", {
        spanId,
        skill: skillName,
        childAgentId: sub.agentId,
        outputBytes: Buffer.byteLength(String(result.text ?? "")),
      });
      return result.text;
    } catch (error) {
      this.recordTrace("skill.fork_failed", { spanId, skill: skillName, childAgentId: sub.agentId, error: error.message });
      throw error;
    }
  }

  async runUserSkill(invocation) {
    if (!invocation) return null;
    this.recordTrace("skill.activated", {
      skill: invocation.name,
      context: invocation.context,
      allowedTools: invocation.allowedTools,
      source: "user",
    });
    if (invocation.context === "fork") return this.runForkedSkill(invocation, invocation.name);
    await this.chat(invocation.prompt);
    return null;
  }

  // ─── ch11：子 Agent fork-return ────────────────────────────────────────
  async executeAgentTool(input) {
    const type = input.type || "general";
    const description = input.description || "sub-agent task";
    const prompt = input.prompt || "";
    printSubAgentStart(type, description);

    const config = getSubAgentConfig(type);
    const subAgent = new Agent({
      model: this.model, apiKey: this.apiKey, baseUrl: this.baseUrl,
      maxOutputTokens: this.maxOutputTokens,
      customSystemPrompt: config.systemPrompt, customTools: config.tools,
      isSubAgent: true,
      mock: this.mock,
      permissionMode: this.permissionMode === "plan" ? "plan" : "bypassPermissions",
      traceRecorder: this.trace,
      skillRegistry: this.skillRegistry,
      parentAgentId: this.agentId,
      permissionPolicy: this.permissionPolicy,
    });
    const spanId = `sub_${this.agentId}_${Math.random().toString(36).slice(2, 6)}`;
    this.recordTrace("subagent.started", { spanId, type, description, childAgentId: subAgent.agentId });
    try {
      const result = await subAgent.runOnce(prompt);
      printSubAgentEnd(type);
      this.recordTrace("subagent.completed", {
        spanId,
        type,
        description,
        childAgentId: subAgent.agentId,
        outputBytes: Buffer.byteLength(String(result.text ?? "")),
      });
      return result.text || "(Sub-agent produced no output)";
    } catch (err) {
      printSubAgentEnd(type);
      this.recordTrace("subagent.failed", { spanId, type, description, childAgentId: subAgent.agentId, error: err.message });
      return `Sub-agent error: ${err.message}`; // 错误回填，父 Agent 不崩
    }
  }

  // 子 Agent 一次性执行：输出收集进 buffer，token 增量计算
  async runOnce(prompt) {
    this.outputBuffer = [];
    await this.chat(prompt);
    const text = this.outputBuffer.join("");
    this.outputBuffer = null;
    return { text };
  }

  // ─── ch10：Plan Mode ───────────────────────────────────────────────────
  buildPlanModePrompt() {
    return `
# Plan Mode Active

Plan mode is active. You MUST NOT make any edits (except the plan file below), run non-readonly tools, or make any changes to the system.

## Plan File: ${this.planFilePath}
Write your plan incrementally to this file using write_file or edit_file.
This is the ONLY file you are allowed to edit.

## Workflow
1. **Explore**: Read code to understand the task. Use read_file, list_files, grep_search.
2. **Design**: Design your implementation approach.
3. **Write Plan**: Write a structured plan to the plan file including Context, Steps, Verification.
4. **Exit**: Call exit_plan_mode when your plan is ready for user review.

IMPORTANT: When your plan is complete, you MUST call exit_plan_mode. Do NOT ask the user to approve — exit_plan_mode handles that.`;
  }

  generatePlanFilePath() {
    const dir = join(homedir(), ".claude", "plans");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    return join(dir, `plan-${this.sessionId}.md`);
  }

  async executePlanModeTool(name) {
    if (name === "enter_plan_mode") {
      if (this.permissionMode === "plan") return "Already in plan mode.";
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      printInfo(`Entered plan mode (read-only). Plan file: ${this.planFilePath}`);
      return `Entered plan mode. You are now in read-only mode.\n\nYour plan file: ${this.planFilePath}\nWrite your plan to this file. This is the only file you can edit.\n\nWhen your plan is complete, call exit_plan_mode.`;
    }

    if (name === "exit_plan_mode") {
      if (this.permissionMode !== "plan") return "Not in plan mode.";
      let planContent = "(No plan file found)";
      if (this.planFilePath && existsSync(this.planFilePath)) planContent = readFileSync(this.planFilePath, "utf-8");

      if (this.planApprovalFn) {
        const result = await this.planApprovalFn(planContent);
        if (result.choice === "keep-planning") {
          const feedback = result.feedback || "Please revise the plan.";
          return `User rejected the plan and wants to keep planning.\n\nUser feedback: ${feedback}\n\nPlease revise your plan based on this feedback. When done, call exit_plan_mode again.`;
        }
        // 批准：确定目标模式
        const targetMode = result.choice === "clear-and-execute" || result.choice === "execute" ? "acceptEdits" : (this.prePlanMode || "default");
        this.permissionMode = targetMode;
        this.prePlanMode = null;
        const savedPlanPath = this.planFilePath;
        this.planFilePath = null;

        if (result.choice === "clear-and-execute") {
          const continuation = `User approved the plan. Context was cleared. Permission mode: ${targetMode}\n\nPlan file: ${savedPlanPath}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
          // 当前 assistant 的 tool_calls 必须先和 tool result 配对；下一轮请求前再重建上下文。
          this.pendingContextReset = continuation;
          printInfo(`Plan approved. Context cleared, executing in ${targetMode} mode.`);
          return continuation;
        }
        printInfo(`Plan approved. Executing in ${targetMode} mode.`);
        return `User approved the plan. Permission mode: ${targetMode}\n\n## Approved Plan:\n${planContent}\n\nProceed with implementation.`;
      }
      // 无审批函数（子 Agent）：直接退出恢复原模式
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      printInfo(`Exited plan mode. Restored to ${this.permissionMode} mode.`);
      return `Exited plan mode. Permission mode restored to: ${this.permissionMode}\n\n## Your Plan:\n${planContent}`;
    }
    return `Unknown plan mode tool: ${name}`;
  }

  togglePlanMode() {
    if (this.permissionMode === "plan") {
      this.permissionMode = this.prePlanMode || "default";
      this.prePlanMode = null;
      this.planFilePath = null;
      printInfo(`Exited plan mode → ${this.permissionMode} mode`);
    } else {
      this.prePlanMode = this.permissionMode;
      this.permissionMode = "plan";
      this.planFilePath = this.generatePlanFilePath();
      printInfo(`Entered plan mode. Plan file: ${this.planFilePath}`);
    }
    return this.permissionMode;
  }

  // ─── 确认 / 会话 / 命令 ────────────────────────────────────────────────
  confirmDangerous(command) {
    printInfo(`需要确认：${command}`);
    if (this.confirmPermission) return this.confirmPermission(command);
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
      rl.question("  Allow? (y/n): ", (answer) => { rl.close(); resolve(answer.trim().toLowerCase().startsWith("y")); });
    });
  }

  buildSideQuery() {
    return async (systemPrompt, userContent) => {
      const res = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: userContent }], max_tokens: 200 }),
      });
      if (!res.ok) throw new Error(`sideQuery ${res.status}`);
      return (await res.json()).choices[0].message.content ?? "";
    };
  }

  history() { return this.messages; }
  clearHistory() { this.messages = []; this.readFileState.clear(); }
  loadHistory(msgs) { this.messages = msgs; }
  autoSave() {
    saveSession(this.sessionId, {
      metadata: { id: this.sessionId, model: this.model, cwd: process.cwd(), startTime: new Date().toISOString(), messageCount: this.messages.length },
      messages: this.messages,
    });
  }

  summarize(middleText) {
    return fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({ model: this.model, messages: [{ role: "system", content: SUMMARY_PROMPT }, { role: "user", content: `以下是即将被压缩的对话（从旧到新）：\n\n${middleText.slice(0, 50000)}` }] }),
    }).then(async (res) => { if (!res.ok) throw new Error(`API ${res.status}`); return (await res.json()).choices[0].message.content ?? "(摘要失败)"; });
  }

  async compact() {
    if (this.messages.length <= KEEP_RECENT) { printInfo("(conversation too short to compact)"); return; }
    this.messages = await maybeCompact(this.messages, (t) => this.summarize(t));
  }

  accumulateUsage(usage) { this.usageTotals.prompt += usage.prompt_tokens ?? 0; this.usageTotals.completion += usage.completion_tokens ?? 0; }

  showCost() {
    const cost = estimateUsageCostCny(this.usageTotals);
    console.log(`cost: prompt ${this.usageTotals.prompt} tok, completion ${this.usageTotals.completion} tok → ≈ ¥${cost.toFixed(4)}`);
  }

  memoryInfo() { printInfo(`记忆目录：${getMemoryDir()}`); }
  refreshSystemPrompt() {
    if (this.usesDefaultSystemPrompt) this.baseSystemPrompt = buildSystemPrompt();
    return this.baseSystemPrompt;
  }
  traceSummary(limit = 20) { return this.trace.formatRecent(limit); }
  abort() { this.controller?.abort(); }
}
