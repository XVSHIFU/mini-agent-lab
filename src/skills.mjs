// ============================================================================
// ch9 · Skills 系统（对应教程 09-skills.md）
// ============================================================================
// 一个技能 = 一个目录下的 SKILL.md：frontmatter 元信息 + prompt 模板。
// 调用分两种：
//   1. 用户手动：`/commit 参数` → CLI 把 prompt 展开后注入对话（inline）
//   2. 模型程序化：skill 工具 → 返回展开后的 prompt（指令即返回值，元工具）
// 执行模式：inline（拼进当前对话）/ fork（丢给干净子 agent 单独跑）
// ============================================================================

import { readFileSync, existsSync, readdirSync, openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { parseFrontmatter } from "./frontmatter.mjs";

const FRONTMATTER_READ_LIMIT = 64 * 1024;

function readFrontmatterOnly(filePath) {
  const fd = openSync(filePath, "r");
  const chunks = [];
  let total = 0;
  try {
    while (total < FRONTMATTER_READ_LIMIT) {
      const buffer = Buffer.alloc(Math.min(4096, FRONTMATTER_READ_LIMIT - total));
      const bytesRead = readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      chunks.push(buffer.subarray(0, bytesRead));
      total += bytesRead;
      const prefix = Buffer.concat(chunks).toString("utf-8");
      const match = prefix.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
      if (match) return match[0];
    }
    return "";
  } finally {
    closeSync(fd);
  }
}

function parseAllowedTools(meta) {
  if (!meta["allowed-tools"]) return undefined;
  const rawTools = meta["allowed-tools"];
  if (rawTools.startsWith("[")) {
    try { return JSON.parse(rawTools); }
    catch { return rawTools.replace(/[\[\]]/g, "").split(",").map((s) => s.trim()); }
  }
  return rawTools.split(",").map((s) => s.trim());
}

function createSkillDescriptor(filePath, source, skillDir) {
  try {
    const { meta } = parseFrontmatter(readFrontmatterOnly(filePath));
    const name = meta.name || skillDir.split(/[\\/]/).pop() || "unknown";
    return {
      name,
      description: meta.description || "",
      whenToUse: meta.when_to_use || meta["when-to-use"],
      allowedTools: parseAllowedTools(meta),
      userInvocable: meta["user-invocable"] !== "false",
      context: meta.context === "fork" ? "fork" : "inline",
      source,
      skillDir,
      filePath,
    };
  } catch {
    return null;
  }
}

export class SkillRegistry {
  constructor({
    userDir = join(homedir(), ".claude", "skills"),
    projectDir = join(process.cwd(), ".claude", "skills"),
  } = {}) {
    this.sources = [
      { dir: userDir, source: "user" },
      { dir: projectDir, source: "project" },
    ];
    this.descriptors = null;
  }

  list() {
    if (this.descriptors) return this.descriptors;
    const map = new Map();
    for (const { dir, source } of this.sources) {
      if (!dir || !existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        const skillDir = join(dir, entry);
        const filePath = join(skillDir, "SKILL.md");
        if (!existsSync(filePath)) continue;
        const descriptor = createSkillDescriptor(filePath, source, skillDir);
        if (descriptor) map.set(descriptor.name, descriptor);
      }
    }
    this.descriptors = [...map.values()];
    return this.descriptors;
  }

  load(name) {
    const descriptor = this.list().find((skill) => skill.name === name);
    if (!descriptor) return null;
    try {
      const { body } = parseFrontmatter(readFileSync(descriptor.filePath, "utf-8"));
      return { ...descriptor, promptTemplate: body };
    } catch {
      return null;
    }
  }

  refresh() {
    this.descriptors = null;
    return this.list();
  }

  execute(name, args = "") {
    const skill = this.load(name);
    if (!skill) return null;
    return {
      prompt: resolveSkillPrompt(skill, args),
      context: skill.context,
      allowedTools: skill.allowedTools,
    };
  }

  resolveInvocation(input) {
    if (!input.startsWith("/")) return null;
    const [name, ...rest] = input.slice(1).split(" ");
    const skill = this.load(name);
    if (!skill || !skill.userInvocable) return null;
    const args = rest.join(" ").trim();
    return {
      name,
      args,
      prompt: resolveSkillPrompt(skill, args),
      context: skill.context,
      allowedTools: skill.allowedTools,
    };
  }

  resolve(input) {
    return this.resolveInvocation(input)?.prompt ?? null;
  }
}

const defaultRegistry = new SkillRegistry();

export function discoverSkills() {
  return defaultRegistry.list();
}

export function getSkillByName(name) {
  return defaultRegistry.load(name);
}

export function refreshSkills() {
  return defaultRegistry.refresh();
}

export function resolveSkillInvocation(input) {
  return defaultRegistry.resolveInvocation(input);
}

export function resolveSkillPrompt(skill, args) {
  let prompt = skill.promptTemplate;
  prompt = prompt.replace(/\$ARGUMENTS|\$\{ARGUMENTS\}/g, args);
  prompt = prompt.replace(/\$\{CLAUDE_SKILL_DIR\}/g, skill.skillDir);
  return prompt;
}

// CLI 用："/name args" → 展开后的 prompt；否则 null
export function resolveSkill(input) {
  return defaultRegistry.resolve(input);
}

// 工具用：模型调用 skill 工具
export function executeSkill(skillName, args) {
  return defaultRegistry.execute(skillName, args || "");
}

// System Prompt 注入段：列出可用技能
export function buildSkillDescriptions() {
  const skills = discoverSkills();
  if (skills.length === 0) return "";
  const invocable = skills.filter((s) => s.userInvocable);
  const autoOnly = skills.filter((s) => !s.userInvocable);

  const lines = ["# Available Skills", ""];
  if (invocable.length) {
    lines.push("User-invocable skills (user types /<name> to invoke):");
    for (const s of invocable) {
      lines.push(`- **/${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }
  if (autoOnly.length) {
    lines.push("Auto-invocable skills (use the skill tool when appropriate):");
    for (const s of autoOnly) {
      lines.push(`- **${s.name}**: ${s.description}`);
      if (s.whenToUse) lines.push(`  When to use: ${s.whenToUse}`);
    }
    lines.push("");
  }
  lines.push("To invoke a skill programmatically, use the `skill` tool.");
  return lines.join("\n");
}
