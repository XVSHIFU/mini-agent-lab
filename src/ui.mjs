// ============================================================================
// ch4 · 终端 UI（对应教程 04-cli-session.md 的 ui.ts）
// ============================================================================
// 所有输出走这里统一格式化。工具结果在 UI 层截断到 500 字符——
// 这是给人看的显示，完整结果已在消息历史里。零依赖（ANSI 转义直接写）。

const C = {
  yellow: "\x1b[33m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m",
  gray: "\x1b[90m", dim: "\x1b[2m", magenta: "\x1b[35m", reset: "\x1b[0m",
};

const TOOL_ICONS = {
  read_file: "📖", write_file: "✏️", edit_file: "✏️", list_files: "📂",
  grep_search: "🔍", run_shell: "💻", web_fetch: "🌐", tool_search: "🔎",
  enter_plan_mode: "🚧", exit_plan_mode: "🚀",
};

function getToolSummary(name, input) {
  switch (name) {
    case "read_file": case "write_file": case "edit_file": return input.file_path ?? "";
    case "list_files": return `${input.pattern ?? ""} in ${input.path ?? "."}`;
    case "grep_search": return `${input.pattern ?? ""} in ${input.path ?? "."}`;
    case "run_shell": return input.command ?? "";
    case "web_fetch": return input.url ?? "";
    case "tool_search": return input.query ?? "";
    default: return (JSON.stringify(input) ?? "").slice(0, 80);
  }
}

export function printToolCall(name, input) {
  const icon = TOOL_ICONS[name] ?? "🔧";
  const summary = getToolSummary(name, input);
  console.log(`${C.yellow}\n  ${icon} ${name}${C.reset}${C.gray} ${summary}${C.reset}`);
}

export function printToolResult(name, result) {
  const maxLen = 500;
  const truncated = result.length > maxLen
    ? `${result.slice(0, maxLen)}${C.gray}\n  ... (${result.length} chars total)${C.reset}`
    : result;
  console.log(`${C.dim}${truncated.split("\n").map((l) => `  ${l}`).join("\n")}${C.reset}`);
}

export function printWelcome(model) {
  console.log(`${C.cyan}\nMini Claude Code (${model}). 输入请求，/help 看命令。Ctrl+C 中断本轮，连按两次退出。${C.reset}\n`);
}

export function printUserPrompt() {
  process.stdout.write(`${C.green}\n❯ ${C.reset}`);
}

export function printInfo(msg) {
  console.log(`${C.gray}${msg}${C.reset}`);
}

export function printError(msg) {
  console.error(`${C.red}${msg}${C.reset}`);
}

export function printSubAgentStart(type, description) {
  console.log(`${C.magenta}\n  ┌─ Sub-agent [${type}]: ${description}${C.reset}`);
}

export function printSubAgentEnd(type) {
  console.log(`${C.magenta}  └─ Sub-agent [${type}] completed${C.reset}`);
}

export function printPlanForApproval(planContent) {
  console.log(`${C.cyan}\n  ━━━ Plan for Approval ━━━${C.reset}`);
  const lines = planContent.split("\n").slice(0, 60);
  for (const line of lines) console.log(`  ${line}`);
  console.log(`${C.cyan}  ━━━━━━━━━━━━━━━━━━━━━━━━${C.reset}\n`);
}

export function printPlanApprovalOptions() {
  console.log(`${C.yellow}  Choose an option:${C.reset}`);
  console.log("    1) Yes, clear context and execute — fresh start with auto-accept edits");
  console.log("    2) Yes, and execute — keep context, auto-accept edits");
  console.log("    3) Yes, manually approve edits — keep context, confirm each edit");
  console.log("    4) No, keep planning — provide feedback to revise");
}
