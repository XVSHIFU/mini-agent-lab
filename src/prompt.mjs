// ============================================================================
// ch3 · System Prompt 工程（对应教程 03-system-prompt.md）
// ============================================================================
// 拆成两半：
//   1. 静态核心 STATIC_CORE —— 身份、规则、工具偏好，跨会话逐字不变
//      （正好能被 prompt 缓存，s07 讲过的"前缀即资产"）
//   2. 动态块 buildDynamicSystemContext —— 当下的环境事实（目录/平台/shell/git）
// CLAUDE.md 项目指令 + 当前日期 → 包成 <system-reminder> 追加（不污染静态核心）
// ============================================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { execSync } from "node:child_process";
import os from "node:os";
import { buildMemoryPromptSection } from "./memory.mjs";
import { buildSkillDescriptions } from "./skills.mjs";

// ─── 静态核心：所有用户、所有会话都相同的角色与规则 ────────────────────────
// 不含任何插值，逐字节不变 —— 这是前缀缓存能命中的前提（s07 纪律①）

const STATIC_CORE = `You are Mini Claude Code, a small coding assistant CLI.
You help with software engineering tasks using the tools available to you.

# Doing tasks
 - Do not propose changes to code you haven't read. Read files first.
 - Do not create files unless necessary. Prefer editing existing files.
 - Avoid over-engineering. Only make changes that were requested.
 - Don't expand scope: fixing a bug doesn't mean refactoring the code around it.
 - Don't add defensive code for scenarios that can't happen.

# Executing actions with care
 - Prefer reversible actions. For risky or destructive ones (rm -rf, git push,
   dropping tables), confirm with the user before proceeding.
 - Your edits must be based on the file's current content: read the file before
   writing or editing it, and re-read it if it may have changed.

# Using your tools
 - Use read_file / edit_file / list_files / grep_search instead of shell cat,
   sed, ls, grep. Reserve run_shell for actual shell operations (tests, git, installs).
 - If several tool calls are independent, make them in parallel.
 - Deferred tools (enter_plan_mode, exit_plan_mode) are NOT loaded by default.
   If you need them, call tool_search to find and activate them first.

# Tone and style
 - Keep responses short and concise. Lead with the answer.
 - Reference code as file_path:line_number.`;

// ─── CLAUDE.md 加载：CWD 向上遍历 + @include 解析 + .claude/rules ──────────

const INCLUDE_REGEX = /^@(\.\/[^\s]+|~\/[^\s]+|\/[^\s]+)$/gm;
const MAX_INCLUDE_DEPTH = 5;

function resolveIncludes(content, basePath, visited = new Set(), depth = 0) {
  if (depth >= MAX_INCLUDE_DEPTH) return content;
  return content.replace(INCLUDE_REGEX, (_m, rawPath) => {
    let resolved;
    if (rawPath.startsWith("~/")) resolved = join(os.homedir(), rawPath.slice(2));
    else if (rawPath.startsWith("/")) resolved = rawPath;
    else resolved = resolve(basePath, rawPath);
    resolved = resolve(resolved);
    if (visited.has(resolved)) return `<!-- circular: ${rawPath} -->`;
    if (!existsSync(resolved)) return `<!-- not found: ${rawPath} -->`;
    try {
      visited.add(resolved);
      return resolveIncludes(readFileSync(resolved, "utf-8"), dirname(resolved), visited, depth + 1);
    } catch {
      return `<!-- error reading: ${rawPath} -->`;
    }
  });
}

function loadRulesDir(dir) {
  const rulesDir = join(dir, ".claude", "rules");
  if (!existsSync(rulesDir)) return "";
  const files = readdirSync(rulesDir).filter((f) => f.endsWith(".md")).sort();
  const parts = files.map((file) => {
    const content = resolveIncludes(readFileSync(join(rulesDir, file), "utf-8"), rulesDir);
    return `<!-- rule: ${file} -->\n${content}`;
  });
  return parts.length > 0 ? `\n\n## Rules\n${parts.join("\n\n")}` : "";
}

export function loadClaudeMd() {
  const parts = [];
  let dir = process.cwd();
  while (true) {
    const file = join(dir, "CLAUDE.md");
    if (existsSync(file)) {
      try {
        parts.unshift(resolveIncludes(readFileSync(file, "utf-8"), dir));
      } catch { /* 读不动就跳过 */ }
    }
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  const rules = loadRulesDir(process.cwd());
  const claudeMd = parts.length > 0
    ? `\n\n# Project Instructions (CLAUDE.md)\n${parts.join("\n\n---\n\n")}`
    : "";
  return claudeMd + rules;
}

// ─── Git 上下文（失败静默返回空）───────────────────────────────────────────

export function getGitContext(cwd = process.cwd()) {
  try {
    // stderr 必须静默：独立包允许在普通目录运行，非 Git 目录不是错误场景。
    const opts = { cwd, encoding: "utf-8", timeout: 3000, stdio: ["ignore", "pipe", "ignore"] };
    const branch = execSync("git rev-parse --abbrev-ref HEAD", opts).trim();
    let log = "", status = "";
    try { log = execSync("git log --oneline -5", opts).trim(); } catch {}
    try { status = execSync("git status --short", opts).trim(); } catch {}
    let result = `\nGit branch: ${branch}`;
    if (log) result += `\nRecent commits:\n${log}`;
    if (status) result += `\nGit status:\n${status}`;
    return result;
  } catch {
    return "";
  }
}

// ─── 组装：静态核心 + 动态环境 ─────────────────────────────────────────────

export function buildStaticSystemPrompt() {
  return STATIC_CORE;
}

export function buildDynamicSystemContext() {
  const platform = `${os.platform()} ${os.arch()}`;
  const shell = process.platform === "win32"
    ? (process.env.ComSpec || "cmd.exe")
    : (process.env.SHELL || "/bin/sh");
  return (
    `# Environment\n` +
    `Working directory: ${process.cwd()}\n` +
    `Platform: ${platform}\n` +
    `Shell: ${shell}` +
    getGitContext() +
    buildMemoryPromptSection() +  // ch8：记忆系统说明 + 索引
    buildSkillDescriptions()      // ch9：可用技能清单
  );
}

export function buildSystemPrompt() {
  return buildStaticSystemPrompt() + "\n\n" + buildDynamicSystemContext();
}

// ─── CLAUDE.md + 日期 → <system-reminder>（追加到会话里，不污染静态核心）───

export function buildUserContextReminder() {
  const date = new Date().toISOString().split("T")[0];
  const claudeMd = loadClaudeMd();
  return `<system-reminder>\n${claudeMd}\n# currentDate\nToday's date is ${date}.\n</system-reminder>`;
}
