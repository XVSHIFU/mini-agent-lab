#!/usr/bin/env node
// ============================================================================
// ch4 · CLI 与会话（对应教程 04-cli-session.md）
// ============================================================================
// 入口：参数解析 → 单次模式 / REPL 模式 / --resume 恢复。
// REPL：/clear /cost /compact /plan + exit，Ctrl+C 双重语义。
//   · 处理中按 Ctrl+C → 中断当前轮（agent.abort）
//   · 空闲按 Ctrl+C → 第一次提醒，第二次退出
// 会话在每次 chat 后自动存盘（agent.autoSave → ~/.mini-claude/sessions）。
//
// 运行（OpenAI 兼容，DeepSeek 可直接用）：
//   $env:AGENT_API_KEY = "sk-xxx"
//   node src/cli.mjs "把 src/tools.mjs 的前 10 行读给我看"
//   node src/cli.mjs                                   # REPL
//   node src/cli.mjs --resume                          # 恢复上次会话
//   node src/cli.mjs --plan                            # 只读计划模式
// 免 key 自测（脚本化 mock 模型，验证循环本身）：
//   node src/cli.mjs --mock "读一下 greeting.txt"
// ============================================================================

import { createInterface } from "node:readline";
import { Agent, DEFAULT_MAX_OUTPUT_TOKENS } from "./agent.mjs";
import { getLatestSessionId, loadSession } from "./session.mjs";
import { discoverSkills, refreshSkills, resolveSkillInvocation } from "./skills.mjs";
import { listMemories } from "./memory.mjs";
import { loadPermissionRules, refreshPermissionRules } from "./permissions.mjs";
import { printWelcome, printUserPrompt, printInfo, printError, printPlanForApproval, printPlanApprovalOptions } from "./ui.mjs";

function parsePositiveInteger(value, fallback) {
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    permissionMode: "default",
    // 默认模型交给 Agent 构造器（undefined → Agent 的默认值生效），
    // 这里不再写死，否则会覆盖你在 agent.mjs 里改的默认模型。
    model: process.env.AGENT_MODEL ?? undefined,
    baseUrl: process.env.AGENT_BASE_URL ?? "https://api.deepseek.com/v1",
    maxOutputTokens: parsePositiveInteger(process.env.AGENT_MAX_TOKENS, DEFAULT_MAX_OUTPUT_TOKENS),
    resume: false, maxTurns: undefined, mock: false, traceEnabled: true, prompt: undefined,
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yolo" || a === "-y") opts.permissionMode = "bypassPermissions";
    else if (a === "--plan") opts.permissionMode = "plan";
    else if (a === "--accept-edits") opts.permissionMode = "acceptEdits";
    else if (a === "--dont-ask") opts.permissionMode = "dontAsk";
    else if (a === "--model" || a === "-m") opts.model = argv[++i] ?? opts.model;
    else if (a === "--api-base") opts.baseUrl = argv[++i] ?? opts.baseUrl;
    else if (a === "--max-tokens") {
      const raw = argv[++i];
      const parsed = parsePositiveInteger(raw, null);
      if (parsed === null) throw new Error("--max-tokens must be a positive integer");
      opts.maxOutputTokens = parsed;
    }
    else if (a === "--resume") opts.resume = true;
    else if (a === "--mock") opts.mock = true;
    else if (a === "--no-trace") opts.traceEnabled = false;
    else if (a === "--max-turns") { const v = parseInt(argv[++i], 10); if (!isNaN(v)) opts.maxTurns = v; }
    else if (a === "--help" || a === "-h") {
      console.log("Usage: node src/cli.mjs [options] [prompt] ...");
      console.log("  --plan, --yolo, --accept-edits  权限模式");
      console.log("  --model <name>, --api-base <url> 模型配置");
      console.log(`  --max-tokens <n>                 输出上限（默认 ${DEFAULT_MAX_OUTPUT_TOKENS}；环境变量 AGENT_MAX_TOKENS）`);
      console.log("  --resume                         恢复上次会话");
      console.log("  --mock                           免 key 脚本化模型");
      console.log("  --no-trace                       关闭本地 JSONL Trace");
      process.exit(0);
    }
    else positional.push(a);
  }
  opts.prompt = positional.length > 0 ? positional.join(" ") : undefined;
  return opts;
}

function resolveApiKey(baseUrl) {
  // OpenAI 兼容端点：优先 AGENT_API_KEY / OPENAI_API_KEY / DEEPSEEK_API_KEY
  return process.env.AGENT_API_KEY
    ?? (baseUrl.includes("openai") ? process.env.OPENAI_API_KEY : undefined)
    ?? process.env.OPENAI_API_KEY
    ?? process.env.DEEPSEEK_API_KEY;
}

async function runRepl(agent) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  // REPL 生命周期内只保留一个 readline；否则同一次按键会被两个 interface 各回显一次。
  agent.confirmPermission = () => new Promise((resolve) => {
    rl.question("  Allow? (y/n): ", (answer) =>
      resolve(answer.trim().toLowerCase().startsWith("y")));
  });

  // ch10：注入 Plan 审批回调（四选一）——解耦 Agent 和 UI 层
  agent.planApprovalFn = (planContent) => new Promise((resolve) => {
    printPlanForApproval(planContent);
    printPlanApprovalOptions();
    const askChoice = () => {
      rl.question("  Enter choice (1-4): ", (answer) => {
        const choice = answer.trim();
        if (choice === "1") resolve({ choice: "clear-and-execute" });
        else if (choice === "2") resolve({ choice: "execute" });
        else if (choice === "3") resolve({ choice: "manual-execute" });
        else if (choice === "4") {
          rl.question("  Feedback (what to change): ", (feedback) => resolve({ choice: "keep-planning", feedback: feedback.trim() || undefined }));
        } else { console.log("  Invalid choice. Enter 1, 2, 3, or 4."); askChoice(); }
      });
    };
    askChoice();
  });

  let sigintCount = 0;
  rl.on("SIGINT", () => {
    if (agent.isProcessing) {
      agent.abort();
      printInfo("(interrupted)");
      sigintCount = 0;
      askQuestion();
    } else {
      sigintCount++;
      if (sigintCount >= 2) { console.log("\nBye!\n"); process.exit(0); }
      printInfo("Press Ctrl+C again to exit.");
      askQuestion();
    }
  });

  printWelcome(agent.model);

  // rl.once 而非 rl.on：保证严格串行，避免多个 chat 并发修改消息历史
  const askQuestion = () => {
    printUserPrompt();
    rl.once("line", async (line) => {
      const input = line.trim();
      sigintCount = 0;

      if (!input) { askQuestion(); return; }
      if (input === "exit" || input === "quit") { console.log("\nBye!\n"); process.exit(0); }

      if (input === "/help") {
        printInfo("/clear /cost /compact /plan /memory /permissions /skills /trace /技能名 — exit — Ctrl+C 中断, 连按两次退出");
        askQuestion(); return;
      }
      if (input === "/clear") { agent.clearHistory(); printInfo("(history cleared)"); askQuestion(); return; }
      if (input === "/cost") { agent.showCost(); askQuestion(); return; }
      if (input === "/plan") { agent.togglePlanMode(); askQuestion(); return; }
      if (input === "/permissions" || input === "/permissions refresh") {
        const rules = input.endsWith(" refresh") ? refreshPermissionRules() : loadPermissionRules();
        printInfo(`permission rules${input.endsWith(" refresh") ? " (refreshed)" : ""}: ${rules.allow.length} allow / ${rules.deny.length} deny`);
        askQuestion(); return;
      }
      if (input === "/skills" || input === "/skills refresh") {
        const skills = input.endsWith(" refresh") ? refreshSkills() : discoverSkills();
        if (input.endsWith(" refresh")) agent.refreshSystemPrompt();
        if (skills.length === 0) printInfo("No skills discovered.");
        else {
          printInfo(`${skills.length} skills${input.endsWith(" refresh") ? " (refreshed)" : ""}:`);
          for (const skill of skills) console.log(`    /${skill.name} [${skill.source}/${skill.context}] — ${skill.description}`);
        }
        askQuestion(); return;
      }
      if (input === "/trace" || input.startsWith("/trace ")) {
        const requested = Number.parseInt(input.split(/\s+/)[1] || "20", 10);
        console.log(agent.traceSummary(Number.isFinite(requested) ? requested : 20));
        askQuestion(); return;
      }
      if (input === "/memory") {
        const ms = listMemories();
        if (ms.length === 0) printInfo("No memories saved yet.");
        else { printInfo(`${ms.length} memories:`); for (const m of ms) console.log(`    [${m.type}] ${m.name} — ${m.description}`); }
        askQuestion(); return;
      }
      if (input === "/compact") {
        try { await agent.compact(); } catch (e) { printError(e.message); }
        askQuestion(); return;
      }

      try {
        await runInput(agent, input);
      } catch (e) {
        if (e.name !== "AbortError" && !(e.message || "").includes("aborted")) printError(e.message);
      }
      agent.autoSave();
      askQuestion();
    });
  };

  askQuestion();
}

async function runInput(agent, input) {
  const invocation = resolveSkillInvocation(input);
  if (!invocation) return agent.chat(input);
  const output = await agent.runUserSkill(invocation);
  if (output) console.log(output);
}

async function main() {
  const opts = parseArgs();
  const apiKey = resolveApiKey(opts.baseUrl);

  if (!opts.mock && !apiKey) {
    printError("API key is required. Set AGENT_API_KEY (or OPENAI_API_KEY) env var.");
    process.exit(1);
  }

  const agent = new Agent({
    model: opts.model, apiKey, baseUrl: opts.baseUrl,
    maxOutputTokens: opts.maxOutputTokens,
    permissionMode: opts.permissionMode, maxTurns: opts.maxTurns, mock: opts.mock,
    traceEnabled: opts.traceEnabled,
  });
  if (opts.resume) {
    const id = getLatestSessionId();
    if (id) {
      const saved = loadSession(id);
      if (saved?.messages) {
        agent.loadHistory(saved.messages);
        printInfo(`(resumed session ${id}: ${saved.messages.length} messages)`);
      }
    }
  }

  if (opts.prompt) {
    // 单次模式同样保留 Skill 的 inline / fork 语义
    await runInput(agent, opts.prompt);
    agent.autoSave();
  } else {
    await runRepl(agent);
  }
}

main().catch((e) => { printError(e.stack || e.message); process.exit(1); });
