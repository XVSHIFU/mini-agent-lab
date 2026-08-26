// ============================================================================
// ch2 · 工具系统（对应教程 02-tools.md，OpenAI function-calling 格式）
// ============================================================================
// 一个工具三样东西：名字、给模型看的说明（schema）、真正干活的函数。
// 定义写成一个静态数组（直接就是发给 API 的 tools 参数），执行走一个分发器。
//
// 本章几个"有坑"的要点：
//   1. edit_file：old_string 必须唯一匹配，否则拒绝（宁可失败也不猜）
//   2. read-before-edit + mtime 防护：编辑前必须先读，读后 mtime 变了就拒绝
//   3. 结果截断 50K：超长工具输出保留头尾，防止撑爆上下文
//   4. deferred 工具 + tool_search：冷启动不把所有 schema 发给模型
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { executeSkill } from "./skills.mjs";
import { saveMemory } from "./memory.mjs";

export const MAX_RESULT_CHARS = 60_000;

// ─── 工具定义（OpenAI function schema，直接发给 API）──────────────────────

export const toolDefinitions = [
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read the contents of a file. Returns the file content with line numbers.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to read" },
        },
        required: ["file_path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Write content to a file. Creates the file if it doesn't exist, overwrites if it does.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to write" },
          content: { type: "string", description: "The content to write to the file" },
        },
        required: ["file_path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Edit a file by replacing an exact string match with new content. The old_string must match exactly and appear exactly once.",
      parameters: {
        type: "object",
        properties: {
          file_path: { type: "string", description: "The path to the file to edit" },
          old_string: { type: "string", description: "The exact string to find and replace" },
          new_string: { type: "string", description: "The string to replace it with" },
        },
        required: ["file_path", "old_string", "new_string"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: 'List files matching a glob pattern (e.g. "**/*.js").',
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: 'Glob pattern to match files (e.g. "**/*.ts")' },
          path: { type: "string", description: "Base directory. Defaults to cwd." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_search",
      description: "Search for a regex pattern in files. Returns matching lines with paths and line numbers.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "The regex pattern to search for" },
          path: { type: "string", description: "Directory or file to search. Defaults to cwd." },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_shell",
      description: "Execute a shell command and return its output. For tests, git, package installs, etc.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The shell command to execute" },
          timeout: { type: "number", description: "Timeout in ms (default 30000)" },
        },
        required: ["command"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_fetch",
      description: "Fetch a URL and return its content as text. For HTML pages, tags are stripped.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to fetch" },
          max_length: { type: "number", description: "Maximum content length (default 50000)" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "tool_search",
      description:
        "Search for available tools by name or keyword. Returns full schemas for matching deferred tools and activates them.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Tool name or search keywords" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "skill",
      description: "Invoke a registered skill by name. Returns the skill's prompt instructions to follow. See the available skills list in the system prompt.",
      parameters: {
        type: "object",
        properties: {
          skill_name: { type: "string", description: "The skill name" },
          args: { type: "string", description: "Optional arguments passed to the skill" },
        },
        required: ["skill_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "agent",
      description:
        "Launch a sub-agent to handle a task autonomously. Sub-agents have isolated context and return their result. Types: 'explore' (read-only, fast search), 'plan' (read-only, structured planning), 'general' (full tools). Default: general",
      parameters: {
        type: "object",
        properties: {
          description: { type: "string", description: "Short (3-5 word) description of the sub-agent's task" },
          prompt: { type: "string", description: "Detailed task instructions for the sub-agent" },
          type: { type: "string", enum: ["explore", "plan", "general"], description: "Agent type. Default: general" },
        },
        required: ["description", "prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "save_memory",
      description: "Save a fact about the user or project to persistent memory (a .md file). Useful for user preferences, corrections, project decisions, and reference pointers.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Short memory name" },
          description: { type: "string", description: "One-line description" },
          type: { type: "string", enum: ["user", "feedback", "project", "reference"], description: "Memory type" },
          content: { type: "string", description: "The memory body" },
        },
        required: ["name", "description", "type", "content"],
      },
    },
  },
];

// 常驻工具里，哪些是"只读、并发安全"的（ch2 提到并行执行，这里串行但保留标记）
export const CONCURRENCY_SAFE_TOOLS = new Set([
  "read_file", "list_files", "grep_search", "web_fetch",
]);

// ─── deferred 工具：冷启动只发名字，需要时用 tool_search 激活（懒加载）─────

export const deferredToolDefinitions = [
  {
    name: "enter_plan_mode",
    description: "Enter plan mode to switch to a read-only planning phase where no edits are allowed.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "exit_plan_mode",
    description: "Exit plan mode and return to normal execution mode.",
    input_schema: { type: "object", properties: {} },
  },
];

// 激活的 deferred 工具名（会话内累积，字节确定性：只增不改，由 agent 持有）
export function createToolRegistrar() {
  const activated = new Set();
  const getActiveToolDefinitions = () => {
    const core = toolDefinitions;
    const deferredActive = deferredToolDefinitions
      .filter((t) => activated.has(t.name))
      .map(({ name, description, input_schema }) => ({
        type: "function",
        function: { name, description, parameters: input_schema },
      }));
    return [...core, ...deferredActive];
  };
  return { activated, getActiveToolDefinitions };
}

// ─── 结果截断：保留头尾（很多命令的关键输出在末尾）────────────────────────

function truncateResult(result) {
  if (result.length <= MAX_RESULT_CHARS) return result;
  const keepEach = Math.floor((MAX_RESULT_CHARS - 60) / 2);
  return (
    result.slice(0, keepEach) +
    `\n\n[... truncated ${result.length - keepEach * 2} chars ...]\n\n` +
    result.slice(-keepEach)
  );
}

// ─── 工具实现 ──────────────────────────────────────────────────────────────

function readFile(input) {
  try {
    const content = readFileSync(input.file_path, "utf-8");
    return content
      .split("\n")
      .map((line, i) => `${String(i + 1).padStart(4)} | ${line}`)
      .join("\n");
  } catch (e) {
    return `Error reading file: ${e.message}`;
  }
}

function writeFile(input) {
  try {
    const dir = path.dirname(input.file_path);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(input.file_path, input.content, "utf-8");
    const n = input.content.split("\n").length;
    return `Successfully wrote to ${input.file_path} (${n} lines)`;
  } catch (e) {
    return `Error writing file: ${e.message}`;
  }
}

// 引号容错：LLM 的 tokenization 可能把直引号映射成弯引号，容错让编辑不 100% 失败
function normalizeQuotes(s) {
  return s
    .replace(/[\u2018\u2019\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"');
}

// 匹配成功后返回文件中的原始字符串（保持文件原始字符风格），而不是标准化版本
function findActualString(fileContent, searchString) {
  if (fileContent.includes(searchString)) return searchString;
  const normSearch = normalizeQuotes(searchString);
  const normFile = normalizeQuotes(fileContent);
  const idx = normFile.indexOf(normSearch);
  if (idx !== -1) return fileContent.substring(idx, idx + searchString.length);
  return null;
}

function editFile(input) {
  try {
    const filePath = path.resolve(input.file_path);
    if (!existsSync(filePath)) return `Error: file not found: ${input.file_path}`;
    const content = readFileSync(filePath, "utf-8");

    const actual = findActualString(content, input.old_string);
    if (actual === null) {
      return `Error: old_string not found in ${input.file_path}. The file may have changed — use read_file first.`;
    }
    const count = content.split(actual).length - 1;
    if (count > 1) {
      return `Error: old_string found ${count} times in ${input.file_path}. Must be unique. Provide more context.`;
    }

    // split/join 避免 String.replace 的 $$ / $& 替换模式展开
    const updated = content.split(actual).join(input.new_string);
    writeFileSync(filePath, updated, "utf-8");

    // 简易 diff：行号 = old_string 前面的换行数
    const startLine = content.slice(0, content.indexOf(actual)).split("\n").length;
    const oldLines = actual.split("\n").length;
    const newLines = input.new_string.split("\n").length;
    const matchedVia = normalizeQuotes(actual) !== actual ? " (matched via quote normalization)" : "";
    return (
      `Successfully edited ${input.file_path}${matchedVia}\n\n` +
      `@@ -${startLine},${oldLines} +${startLine},${newLines} @@\n` +
      `- ${actual.split("\n").join("\n- ")}\n` +
      `+ ${input.new_string.split("\n").join("\n+ ")}`
    );
  } catch (e) {
    return `Error editing file: ${e.message}`;
  }
}

// glob 模式 → 正则（支持 ** / * / ?），零依赖
function globToRegExp(glob) {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") { re += ".*"; i++; }
      else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (/[.+()\[\]{}^$|\\]/.test(c)) re += "\\" + c;
    else re += c;
  }
  return new RegExp(`^${re}$`);
}

function listFiles(input) {
  try {
    const base = input.path || ".";
    const regex = globToRegExp(input.pattern);
    const hits = [];
    const walk = (dir) => {
      let entries;
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (name === "node_modules" || name === ".git") continue;
        const full = path.join(dir, name);
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.isDirectory()) walk(full);
        else {
          // Windows 下 path.relative 返回反斜杠，统一成 / 再匹配 glob 正则
          const rel = path.relative(base, full).split(path.sep).join("/");
          if (regex.test(rel)) hits.push(rel);
        }
      }
    };
    walk(base);
    if (hits.length === 0) return "No files found matching the pattern.";
    return hits.slice(0, 200).join("\n");
  } catch (e) {
    return `Error listing files: ${e.message}`;
  }
}

// 用 JS walker（零依赖、跨平台）——Windows 没有系统 grep，这是最稳的路径
function grepSearch(input) {
  let re;
  try { re = new RegExp(input.pattern); } catch (e) { return `Error: invalid regex: ${e.message}`; }
  const base = input.path || ".";
  const matches = [];
  const scanLines = (full) => {
    try {
      readFileSync(full, "utf-8").split("\n").forEach((line, i) => {
        if (re.test(line) && matches.length < 100) matches.push(`${full}:${i + 1}:${line}`);
      });
    } catch { /* 二进制文件跳过 */ }
  };

  // 路径是文件 → 直接搜；是目录 → 递归（模型常把单个文件传给 grep_search）
  let st;
  try { st = statSync(base); } catch { return `Error: path not found: ${base}`; }
  if (st.isFile()) {
    scanLines(base);
    return matches.length ? matches.join("\n") : "No matches found.";
  }

  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir); } catch { return; }
    for (const name of entries) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = path.join(dir, name);
      let e;
      try { e = statSync(full); } catch { continue; }
      if (e.isDirectory()) { walk(full); continue; }
      scanLines(full);
    }
  };
  walk(base);
  return matches.length ? matches.join("\n") : "No matches found.";
}

function runShell(input) {
  // Windows 中文输出是 GBK，Node 按 UTF-8 读会乱码 → 每条命令先切到 UTF-8 代码页
  const cmd = process.platform === "win32" ? `chcp 65001 >nul && ${input.command}` : input.command;
  try {
    const out = execSync(cmd, {
      encoding: "utf-8",
      maxBuffer: 5 * 1024 * 1024,
      timeout: input.timeout || 30000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out || "(no output)";
  } catch (e) {
    const stderr = e.stderr ? `\nStderr: ${e.stderr}` : "";
    const stdout = e.stdout ? `\nStdout: ${e.stdout}` : "";
    return `Command failed (exit code ${e.status})${stdout}${stderr}`;
  }
}

async function webFetch(input) {
  const url = input.url;
  const maxLength = input.max_length || 50000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { "User-Agent": "mini-claude/1.0" },
    });
    clearTimeout(timeout);
    if (!res.ok) return `HTTP error: ${res.status} ${res.statusText}`;
    let text = await res.text();
    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("html")) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
        .replace(/\s{2,}/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }
    if (text.length > maxLength) text = text.slice(0, maxLength) + `\n\n[... truncated at ${maxLength} characters]`;
    return text || "(empty response)";
  } catch (err) {
    clearTimeout(timeout);
    return err.name === "AbortError"
      ? "Error: Request timed out (30s)"
      : `Error fetching ${url}: ${err.message}`;
  }
}

// deferred 工具的实际执行（plan mode 由 agent 层处理，这里只认名字）
async function executeTool(name, input, { readFileState, permissionMode, registrar } = {}) {
  let result;
  switch (name) {
    case "read_file":
      result = readFile(input);
      // 记录 mtime：这是 read-before-edit 的凭证
      if (readFileState && !result.startsWith("Error")) {
        const abs = path.resolve(input.file_path);
        try { readFileState.set(abs, statSync(abs).mtimeMs); } catch { /* 文件可能刚被删 */ }
      }
      break;

    case "write_file": {
      const abs = path.resolve(input.file_path);
      if (readFileState && existsSync(abs)) {
        // 已存在的文件必须先 read（read-before-edit）
        if (!readFileState.has(abs)) {
          return "Error: You must read this file before writing. Use read_file first.";
        }
        // mtime 变化说明文件被外部修改
        const cur = statSync(abs).mtimeMs;
        if (cur !== readFileState.get(abs)) {
          return "Warning: file was modified externally. Please read_file again.";
        }
      }
      result = writeFile(input);
      if (readFileState && !result.startsWith("Error")) {
        try { readFileState.set(abs, statSync(abs).mtimeMs); } catch {}
      }
      break;
    }

    case "edit_file": {
      const abs = path.resolve(input.file_path);
      if (readFileState && existsSync(abs)) {
        if (!readFileState.has(abs)) {
          return "Error: You must read this file before editing. Use read_file first.";
        }
        const cur = statSync(abs).mtimeMs;
        if (cur !== readFileState.get(abs)) {
          return "Warning: file was modified externally. Please read_file again.";
        }
      }
      result = editFile(input);
      if (readFileState && !result.startsWith("Error")) {
        try { readFileState.set(abs, statSync(abs).mtimeMs); } catch {}
      }
      break;
    }

    case "list_files": result = listFiles(input); break;
    case "grep_search": result = grepSearch(input); break;
    case "run_shell": result = runShell(input); break;
    case "web_fetch": result = await webFetch(input); break;

    case "tool_search": {
      const query = (input.query || "").toLowerCase();
      const matches = deferredToolDefinitions.filter(
        (t) => t.name.toLowerCase().includes(query) || (t.description || "").toLowerCase().includes(query),
      );
      if (matches.length === 0) return "No matching deferred tools found.";
      for (const m of matches) registrar?.activated.add(m.name);
      return JSON.stringify(matches.map((t) => ({
        name: t.name, description: t.description, input_schema: t.input_schema,
      })), null, 2);
    }

    case "skill": {
      // 元工具：返回展开后的 prompt，模型按它执行（ch9）
      const skill = executeSkill(input.skill_name, input.args || "");
      if (!skill) return `Unknown skill: ${input.skill_name}`;
      return `[Skill "${input.skill_name}" activated]\n\n${skill.prompt}`;
    }

    case "save_memory": {
      // 记忆工具：把事实写进磁盘（ch8）
      try {
        const filename = saveMemory({ name: input.name, description: input.description, type: input.type, content: input.content });
        return `已保存记忆 ${filename}`;
      } catch (e) {
        return `保存记忆失败：${e.message}`;
      }
    }

    case "enter_plan_mode": return "Plan mode is already active (handled in agent).";
    case "exit_plan_mode": return "Plan mode already exited (handled in agent).";

    default:
      return `Unknown tool: ${name}`; // 错误是数据，不是异常——让模型自我纠正
  }
  return truncateResult(result);
}

export { executeTool };
