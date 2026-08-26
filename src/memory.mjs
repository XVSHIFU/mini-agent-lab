// ============================================================================
// ch8 · 记忆系统（对应教程 08-memory.md）
// ============================================================================
// 跨会话长期记忆：事实写成磁盘上的小文件（一份记忆一个 .md），
// 每次对话前按当前问题的相关度召回几条、拼进 System Prompt。
//
// 两种召回：
//   1. 关键词匹配（确定性、零 API）—— query 与记忆文件的词重叠度排序
//   2. 语义召回（sideQuery，调一次模型）—— 模型从文件名+描述里选相关记忆
// 语义召回配异步预取：用户提交的瞬间启动，与第一次 API 调用并行。
// ============================================================================

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter, formatFrontmatter, slugify } from "./frontmatter.mjs";

const MEMORY_TYPES = ["user", "feedback", "project", "reference"];
const MAX_INDEX_LINES = 200;
const MAX_INDEX_BYTES = 25_000;
const MAX_MEMORY_BYTES_PER_FILE = 4096;
const MAX_SESSION_MEMORY_BYTES = 60 * 1024;

export function getProjectHash() {
  return createHash("sha256").update(process.cwd()).digest("hex").slice(0, 16);
}

export function getMemoryDir() {
  return join(homedir(), ".mini-claude", "projects", getProjectHash(), "memory");
}

export function getIndexPath() {
  return join(getMemoryDir(), "MEMORY.md");
}

function ensureDir() { mkdirSync(getMemoryDir(), { recursive: true }); }

// ─── 保存记忆（模型通过 write_file 调用；这里提供程序化入口）──────────────

export function saveMemory({ name, description, type, content }) {
  if (!MEMORY_TYPES.includes(type)) throw new Error(`invalid memory type: ${type}`);
  ensureDir();
  const filename = `${type}_${slugify(name)}.md`;
  writeFileSync(join(getMemoryDir(), filename), formatFrontmatter(
    { name, description, type }, content,
  ), "utf-8");
  updateMemoryIndex();
  return filename;
}

export function listMemories() {
  const dir = getMemoryDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "MEMORY.md")
    .map((filename) => {
      const filePath = join(dir, filename);
      const { meta } = parseFrontmatter(readFileSync(filePath, "utf-8"));
      return {
        filename, filePath,
        name: meta.name || filename, description: meta.description || "",
        type: meta.type || "unknown",
        mtimeMs: statSync(filePath).mtimeMs,
      };
    });
}

export function updateMemoryIndex() {
  const memories = listMemories();
  const lines = ["# Memory Index", ""];
  for (const m of memories) lines.push(`- **[${m.name}](${m.filename})** (${m.type}) — ${m.description}`);
  writeFileSync(getIndexPath(), lines.join("\n"), "utf-8");
}

export function loadMemoryIndex() {
  const p = getIndexPath();
  if (!existsSync(p)) return "";
  let content = readFileSync(p, "utf-8");
  const lines = content.split("\n");
  if (lines.length > MAX_INDEX_LINES) content = lines.slice(0, MAX_INDEX_LINES).join("\n") + "\n\n[... truncated, too many memory entries ...]";
  if (Buffer.byteLength(content) > MAX_INDEX_BYTES) content = content.slice(0, MAX_INDEX_BYTES) + "\n\n[... truncated, index too large ...]";
  return content;
}

// ─── 关键词召回（确定性、零 API）──────────────────────────────────────────

export function recallMemories(query) {
  const dir = getMemoryDir();
  if (!existsSync(dir)) return "";
  const queryWords = new Set(query.toLowerCase().split(/\W+/).filter((w) => w.length > 2));

  const scored = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".md") || f === "MEMORY.md") continue;
    const text = readFileSync(join(dir, f), "utf-8").trim();
    const words = new Set(text.toLowerCase().split(/\W+/));
    let score = 0;
    for (const w of queryWords) if (words.has(w)) score++;
    if (score > 0) scored.push({ text, score });
  }
  if (scored.length === 0) return "";

  const top = scored.sort((a, b) => b.score - a.score).slice(0, 3).map((s) => `- ${s.text}`).join("\n");
  return `\n\n# Memory (things you remember about the user and project)\n${top}`;
}

// ─── 语义召回（sideQuery）：模型从清单里选相关记忆 ────────────────────────

const SELECT_MEMORIES_PROMPT = `You are selecting memories useful to an AI coding assistant processing a user's query.
Return ONLY a JSON object: {"selected_memories": ["filename", ...]} (up to 5).
Only include memories you are CERTAIN will help, based on filename and description.
If unsure, do not include. If none clearly help, return {"selected_memories": []}.`;

export async function selectRelevantMemories(query, sideQuery, alreadySurfaced) {
  const memories = listMemories();
  const candidates = memories.filter((m) => !alreadySurfaced.has(m.filePath));
  if (candidates.length === 0) return [];

  const manifest = candidates.map((m) => `- ${m.filename}: ${m.description}`).join("\n");
  let text;
  try {
    text = await sideQuery(SELECT_MEMORIES_PROMPT, `Query: ${query}\n\nAvailable memories:\n${manifest}`);
  } catch (err) {
    console.error(`[memory] semantic recall failed: ${err.message}`); // 静默失败，不阻塞主循环
    return [];
  }

  const jsonMatch = String(text ?? "").match(/\{[\s\S]*\}/);
  if (!jsonMatch) return [];
  try {
    const selected = JSON.parse(jsonMatch[0]).selected_memories ?? [];
    const set = new Set(selected);
    return candidates.filter((h) => set.has(h.filename)).slice(0, 5).map((h) => {
      let content = readFileSync(h.filePath, "utf-8");
      const { body } = parseFrontmatter(content);
      if (Buffer.byteLength(body) > MAX_MEMORY_BYTES_PER_FILE) {
        // 单文件 4KB 截断
      }
      const days = Math.max(0, Math.floor((Date.now() - h.mtimeMs) / 86_400_000));
      const header = days > 1
        ? `This memory is ${days} days old. Memories are point-in-time observations, not live state — verify against current code.`
        : `Memory (saved ${days <= 0 ? "today" : `${days}d ago`}): ${h.filePath}`;
      return { path: h.filePath, content: body.slice(0, MAX_MEMORY_BYTES_PER_FILE), header };
    });
  } catch { return []; }
}

// ─── 异步预取：用户提交瞬间启动，与第一次模型调用并行 ─────────────────────

export function startMemoryPrefetch(query, sideQuery, alreadySurfaced, sessionMemoryBytes) {
  // 门控 1: 太短的查询跳过
  if (!/\s/.test(query.trim()) && [...query.trim()].length < 2) return null;
  // 门控 2: 会话预算已满
  if (sessionMemoryBytes >= MAX_SESSION_MEMORY_BYTES) return null;
  // 门控 3: 没有记忆文件
  const dir = getMemoryDir();
  if (!existsSync(dir) || !readdirSync(dir).some((f) => f.endsWith(".md") && f !== "MEMORY.md")) return null;

  const handle = {
    promise: selectRelevantMemories(query, sideQuery, alreadySurfaced),
    settled: false, consumed: false,
  };
  handle.promise.then(() => { handle.settled = true; }).catch(() => { handle.settled = true; });
  return handle;
}

export function formatMemoriesForInjection(memories) {
  return memories
    .map((m) => `<system-reminder>\n${m.header}\n\n${m.content}\n</system-reminder>`)
    .join("\n\n");
}

// ─── System Prompt 注入段：教模型分类、操作、克制 ─────────────────────────

export function buildMemoryPromptSection() {
  const index = loadMemoryIndex();
  const memoryDir = getMemoryDir();
  return `# Memory System

You have a persistent, file-based memory system at \`${memoryDir}\`.

## Memory Types
- **user**: User's role, preferences, knowledge level
- **feedback**: Corrections and guidance from the user (record both corrections AND praise)
- **project**: Ongoing work, goals, deadlines, decisions
- **reference**: Pointers to external resources

## How to Save Memories
Use the write_file tool to create a memory file with YAML frontmatter:
\`\`\`
---
name: <short name>
description: <one line>
type: <user|feedback|project|reference>
---
<content>
\`\`\`
Save to: \`${memoryDir}/\`
Filename format: \`{type}_{slugified_name}.md\`

## What NOT to Save
- Code patterns or architecture (read the code instead)
- Git history (use git log)
- Anything already in CLAUDE.md
- Ephemeral task details

${index ? `## Current Memory Index\n${index}` : "(No memories saved yet.)"}`;
}
