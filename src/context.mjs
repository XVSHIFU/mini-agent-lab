// ============================================================================
// ch7 · 上下文管理（对应教程 07-context.md）
// ============================================================================
// 渐进式压缩：从最轻到最重，能用轻的就不上重的。
//   Tier 0.5  大结果持久化（>30KB 落盘，上下文只留预览+路径）
//   Tier 1    Budget    动态收紧历史中工具结果的大小（利用率 50%/70% 双阈值）
//   Tier 2    Snip      替换过时工具结果（同文件重复读取去重）
//   Tier 3    Microcompact  空闲 >5min 激进清理旧工具结果
//   Tier 4    Auto-compact  全量 LLM 摘要（turn boundary 触发）
// ============================================================================

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// ─── Tier 0.5：大结果持久化（可恢复 vs 截断的根本区别）────────────────────

const PERSIST_THRESHOLD = 30 * 1024; // 30KB

export function persistLargeResult(toolName, result) {
  if (Buffer.byteLength(result) <= PERSIST_THRESHOLD) return result;

  const dir = join(homedir(), ".mini-claude", "tool-results");
  mkdirSync(dir, { recursive: true });
  const filename = `${Date.now()}-${toolName}.txt`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, result);

  const lines = result.split("\n");
  const preview = lines.slice(0, 200).join("\n");
  const sizeKB = (Buffer.byteLength(result) / 1024).toFixed(1);

  return `[Result too large (${sizeKB} KB, ${lines.length} lines). Full output saved to ${filepath}. Use read_file to see the full result.]\n\nPreview (first 200 lines):\n${preview}`;
}

// ─── Tier 1：Budget —— 随上下文利用率收紧工具结果大小 ─────────────────────

export function budgetToolResults(messages, utilization) {
  if (utilization < 0.5) return;
  const budget = utilization > 0.7 ? 15000 : 30000;
  for (const msg of messages) {
    if (msg.role !== "tool" || typeof msg.content !== "string") continue;
    if (msg.content.length > budget) {
      const keepEach = Math.floor((budget - 80) / 2);
      msg.content =
        msg.content.slice(0, keepEach) +
        `\n\n[... budgeted: ${msg.content.length - keepEach * 2} chars truncated ...]\n\n` +
        msg.content.slice(-keepEach);
    }
  }
}

// ─── Tier 2：Snip —— 替换过时的工具结果 ───────────────────────────────────

const SNIPPABLE = new Set(["read_file", "grep_search", "list_files", "run_shell"]);
const SNIP_PLACEHOLDER = "[Content snipped - re-read if needed]";
const KEEP_RECENT_RESULTS = 3;

// OpenAI 格式下工具结果不带工具名（只有 tool_call_id），需要跟前面 assistant 的
// tool_calls 对上。这里按 tool_call_id 从历史里反向找工具名。
function toolNameOf(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      const c = m.tool_calls.find((tc) => tc.id === toolCallId);
      if (c) return c.function?.name ?? "";
    }
  }
  return "";
}

export function snipStaleResults(messages) {
  // 只对"过时"的结果动手：最近的 KEEP_RECENT_RESULTS 条永远保留
  const toolMsgs = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool") toolMsgs.push(i);
  }
  const recent = new Set(toolMsgs.slice(-KEEP_RECENT_RESULTS));

  // 同一文件被 read_file 多次读取 → 只保留最新一次
  const seenReads = new Map(); // file_path -> message index
  for (const i of toolMsgs) {
    if (recent.has(i)) continue;
    const name = toolNameOf(messages, messages[i].tool_call_id);
    if (name !== "read_file") continue;
    const file = extractFilePath(messages, messages[i].tool_call_id);
    if (!file) continue;
    if (seenReads.has(file)) {
      const prevIdx = seenReads.get(file);
      if (typeof messages[prevIdx]?.content === "string") {
        messages[prevIdx].content = SNIP_PLACEHOLDER; // 旧读取被裁
      }
    }
    seenReads.set(file, i);
  }
}

function extractFilePath(messages, toolCallId) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === "assistant" && m.tool_calls) {
      const c = m.tool_calls.find((tc) => tc.id === toolCallId);
      if (c) {
        try {
          const args = JSON.parse(c.function?.arguments || "{}");
          return args.file_path ?? "";
        } catch { return ""; }
      }
    }
  }
  return "";
}

// ─── Tier 3：Microcompact —— 缓存冷启动（空闲 >5min）时无差别清理 ─────────

const MICROCOMPACT_IDLE_MS = 5 * 60 * 1000;

export function microcompact(messages, lastApiCallTime) {
  if (!lastApiCallTime || (Date.now() - lastApiCallTime) < MICROCOMPACT_IDLE_MS) return;
  const toolMsgs = [];
  for (let i = 0; i < messages.length; i++) if (messages[i].role === "tool") toolMsgs.push(i);
  const recent = new Set(toolMsgs.slice(-3));
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "tool" && !recent.has(i) && typeof messages[i].content === "string") {
      messages[i].content = "[Old result cleared]";
    }
  }
}

// ─── Tier 1-3 编排：每次 API 调用前跑（零 API 成本）───────────────────────

export function runCompressionPipeline(messages, { utilization = 0, lastApiCallTime = 0 } = {}) {
  budgetToolResults(messages, utilization);   // Tier 1
  snipStaleResults(messages);                 // Tier 2
  microcompact(messages, lastApiCallTime);    // Tier 3
}

// ─── Tier 4：Auto-compact —— 全量摘要（turn boundary 触发）────────────────

export const COMPACT_THRESHOLD = 12; // 消息数阈值（简化版）
export const KEEP_RECENT = 8;

// 简化触发：消息太多或超窗口时，用 LLM 把旧消息压成摘要
export async function maybeCompact(messages, summarize) {
  if (messages.length <= COMPACT_THRESHOLD) return messages;

  const older = messages.slice(0, messages.length - KEEP_RECENT);
  const recent = messages.slice(messages.length - KEEP_RECENT);

  // 渲染成纯文本：把 tool 消息标记为 [tool result]，避免拆散 assistant(tool_calls)/tool 配对
  const transcript = older.map((m) => {
    if (m.role === "tool") return "tool: [result]";
    if (m.role === "assistant" && m.tool_calls?.length) return `assistant: [tool calls: ${m.tool_calls.map((c) => c.function?.name).join(", ")}]`;
    return `${m.role}: ${m.content}`;
  }).join("\n");

  const summary = await summarize(transcript);
  console.log(`\n  (compacted ${older.length} messages into a summary)`);
  return [{ role: "user", content: `[上下文压缩] 更早的 ${older.length} 条对话：\n${summary}` }, ...recent];
}
