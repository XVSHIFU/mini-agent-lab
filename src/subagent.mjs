// ============================================================================
// ch11 · 子 Agent（对应教程 11-multi-agent.md）
// ============================================================================
// 子 Agent 本质上就是一个"配置不同的 Agent 实例"：自己的干净上下文，
// 啃完只把结果带回来，不把一路中间过程灌回主对话。这是"分而治之"。
//
// 三种内置类型：
//   explore —— 只读、快速搜索（连 shell 都不给，从工具层面断掉破坏可能）
//   plan    —— 只读、结构化规划
//   general —— 完整工具（排除 agent，防止无限递归创建子 Agent）
// 自定义类型：.claude/agents/*.md（frontmatter 指定 allowed-tools）
// ============================================================================

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "./frontmatter.mjs";

export const READ_ONLY_TOOLS = new Set(["read_file", "list_files", "grep_search"]);

const EXPLORE_PROMPT = `You are an Explore agent — a fast, READ-ONLY sub-agent specialized for codebase exploration.

IMPORTANT CONSTRAINTS:
- You are READ-ONLY. You only have access to read_file, list_files, and grep_search.
- Do NOT modify any files.

Be fast and thorough. Use multiple tool calls when possible.
Return a concise summary of your findings.`;

const PLAN_PROMPT = `You are a Plan agent — a READ-ONLY sub-agent specialized for designing implementation plans.

Your job:
- Analyze the codebase to understand the current architecture
- Design a step-by-step implementation plan
- Identify critical files that need modification
- Consider architectural trade-offs

Return a structured plan with:
1. Summary of current state
2. Step-by-step implementation steps
3. Critical files for implementation
4. Potential risks or considerations`;

const GENERAL_PROMPT = `You are a General sub-agent handling an independent task.
Complete the assigned task and return a concise result. You have access to all tools.`;

// ─── 自定义 Agent：.claude/agents/*.md ─────────────────────────────────────
// 与 Claude Code 完全一致的扩展方式，frontmatter 指定 allowed-tools。

function loadAgentsFromDir(dir, map) {
  if (!existsSync(dir)) return;
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".md")) continue;
    try {
      const raw = readFileSync(join(dir, file), "utf-8");
      const { meta, body } = parseFrontmatter(raw);
      const name = meta.name || file.slice(0, -".md".length);
      let allowedTools;
      if (meta["allowed-tools"]) {
        const rawTools = meta["allowed-tools"];
        allowedTools = rawTools.startsWith("[")
          ? (() => { try { return JSON.parse(rawTools); } catch { return rawTools.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()); } })()
          : rawTools.split(",").map((s) => s.trim());
      }
      map.set(name, { name, description: meta.description || "", allowedTools, systemPrompt: body });
    } catch { /* 跳过坏文件 */ }
  }
}

export function discoverCustomAgents() {
  const map = new Map();
  loadAgentsFromDir(join(homedir(), ".claude", "agents"), map);   // 用户级
  loadAgentsFromDir(join(process.cwd(), ".claude", "agents"), map); // 项目级覆盖
  return map;
}

export function getSubAgentConfig(type) {
  // 先查自定义 Agent
  const custom = discoverCustomAgents().get(type);
  if (custom) {
    const tools = custom.allowedTools
      ? toolDefinitions.filter((t) => custom.allowedTools.includes(t.function.name))
      : toolDefinitions.filter((t) => t.function.name !== "agent");
    return { systemPrompt: custom.systemPrompt, tools };
  }
  switch (type) {
    case "explore":
      return { systemPrompt: EXPLORE_PROMPT, tools: getReadOnlyToolDefs() };
    case "plan":
      return { systemPrompt: PLAN_PROMPT, tools: getReadOnlyToolDefs() };
    case "general":
    default:
      return { systemPrompt: GENERAL_PROMPT, tools: getGeneralToolDefs() };
  }
}

// 从 tools.mjs 动态拿工具定义，避免循环依赖
import { toolDefinitions } from "./tools.mjs";

function getReadOnlyToolDefs() {
  return toolDefinitions.filter((t) => READ_ONLY_TOOLS.has(t.function.name));
}

// general 需要"除 agent 外的全部工具"
export function getGeneralToolDefs() {
  return toolDefinitions.filter((t) => t.function.name !== "agent");
}
