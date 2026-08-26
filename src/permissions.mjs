// ============================================================================
// ch6 · 权限与安全（对应教程 06-permissions.md）
// ============================================================================
// 核心思路：deny 优先，连 --yolo 也拦得住。
//   先查 deny 规则 → 再看 plan 只读契约 → 然后才轮到 bypass / allow 规则 /
//   内置危险检测 / 会话白名单 / 用户确认。
// 5 种权限模式：default / plan / acceptEdits / bypassPermissions / dontAsk
// 规则来源：~/.claude/settings.json（用户级）+ .claude/settings.json（项目级）
// ============================================================================

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// 内置危险命令检测（16 个正则：10 Unix + 6 Windows）
export const DANGEROUS_PATTERNS = [
  /\brm\s/, /\bgit\s+(push|reset|clean|checkout\s+\.)/, /\bsudo\b/, /\bmkfs\b/, /\bdd\s/,
  />\s*\/dev\//, /\bkill\b/, /\bpkill\b/, /\breboot\b/, /\bshutdown\b/,
  // Windows
  /\bdel\s/i, /\brmdir\s/i, /\bformat\s/i, /\btaskkill\s/i, /\bRemove-Item\s/i, /\bStop-Process\s/i,
];

export function isDangerous(command) {
  return DANGEROUS_PATTERNS.some((p) => p.test(command));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesGlob(value, pattern) {
  const source = String(pattern)
    .split("*")
    .map(escapeRegExp)
    .join(".*");
  return new RegExp(`^${source}$`).test(value);
}

function normalizeDeclarativeRule(rule, effect) {
  if (typeof rule === "string") {
    const parsed = parseRule(rule);
    return { ...parsed, effect };
  }
  return {
    tool: rule?.tool,
    pattern: rule?.pattern ?? null,
    reason: rule?.reason,
    effect,
  };
}

function getRuleTarget(toolName, input) {
  if (toolName === "run_shell") return input.command || "";
  return input.file_path || input.path || "";
}

function matchesDeclarativeRule(rule, toolName, input) {
  if (!rule.tool || rule.tool !== toolName) return false;
  if (!rule.pattern) return true;
  return matchesGlob(getRuleTarget(toolName, input), rule.pattern);
}

export function createPermissionPolicy({ allow = [], deny = [], fileExists = existsSync } = {}) {
  const rules = [
    ...deny.map((rule) => normalizeDeclarativeRule(rule, "deny")),
    ...allow.map((rule) => normalizeDeclarativeRule(rule, "allow")),
  ];

  return {
    evaluate(toolName, input = {}, { mode = "default", planFilePath } = {}) {
      const matchedRule = rules.find((rule) =>
        rule.effect === "deny" && matchesDeclarativeRule(rule, toolName, input));
      if (matchedRule) {
        return {
          action: "deny",
          reasonCode: "rule_deny",
          message: matchedRule.reason || `Denied by permission rule for ${toolName}`,
          matchedRule,
        };
      }

      if (mode === "plan") {
        if (toolName.startsWith("mcp__")) {
          return {
            action: "deny",
            reasonCode: "plan_mcp_blocked",
            message: `MCP tool blocked in plan mode because its side effects are unknown: ${toolName}`,
          };
        }
        if (EDIT_TOOLS.has(toolName)) {
          const filePath = input.file_path || input.path;
          if (planFilePath && filePath === planFilePath) {
            return { action: "allow", reasonCode: "plan_file_allow" };
          }
          return {
            action: "deny",
            reasonCode: "plan_write_blocked",
            message: `Blocked in plan mode: ${toolName}`,
          };
        }
        if (toolName === "run_shell") {
          return {
            action: "deny",
            reasonCode: "plan_shell_blocked",
            message: "Shell commands blocked in plan mode",
          };
        }
      }

      if (mode === "bypassPermissions") {
        return { action: "allow", reasonCode: "mode_bypass" };
      }

      const allowedRule = rules.find((rule) =>
        rule.effect === "allow" && matchesDeclarativeRule(rule, toolName, input));
      if (allowedRule) {
        return {
          action: "allow",
          reasonCode: "rule_allow",
          message: allowedRule.reason || `Allowed by permission rule for ${toolName}`,
          matchedRule: allowedRule,
        };
      }

      if (READ_TOOLS.has(toolName)) {
        return { action: "allow", reasonCode: "readonly_tool" };
      }
      if (mode === "acceptEdits" && EDIT_TOOLS.has(toolName)) {
        return { action: "allow", reasonCode: "mode_accept_edits" };
      }

      let confirmMessage = null;
      if (toolName === "run_shell" && isDangerous(input.command || "")) {
        confirmMessage = input.command;
      } else if (toolName === "write_file" && !fileExists(input.file_path || "")) {
        confirmMessage = `write new file: ${input.file_path}`;
      } else if (toolName === "edit_file" && !fileExists(input.file_path || "")) {
        confirmMessage = `edit non-existent file: ${input.file_path}`;
      }

      if (confirmMessage) {
        if (mode === "dontAsk") {
          return {
            action: "deny",
            reasonCode: "confirmation_auto_denied",
            message: `Auto-denied (dontAsk mode): ${confirmMessage}`,
          };
        }
        return { action: "confirm", reasonCode: "confirmation_required", message: confirmMessage };
      }

      return { action: "allow", reasonCode: "default_allow" };
    },
  };
}

const READ_TOOLS = new Set(["read_file", "list_files", "grep_search", "web_fetch"]);
const EDIT_TOOLS = new Set(["write_file", "edit_file"]);

// ─── 规则系统：allow/deny，配置文件加载 ───────────────────────────────────
// 两个文件的规则追加到同一数组（不是覆盖），用户级和项目级并存。结果缓存。

function parseRule(rule) {
  const m = rule.match(/^([a-z_]+)\((.+)\)$/);
  if (m) return { tool: m[1], pattern: m[2] };
  return { tool: rule, pattern: null };
}

function loadSettings(filePath) {
  try {
    if (!existsSync(filePath)) return null;
    return JSON.parse(readFileSync(filePath, "utf-8"));
  } catch { return null; }
}

let cachedRules = null;

export function loadPermissionRules() {
  if (cachedRules) return cachedRules;
  const allow = [], deny = [];
  for (const settings of [loadSettings(join(homedir(), ".claude", "settings.json")),
                           loadSettings(join(process.cwd(), ".claude", "settings.json"))]) {
    if (!settings?.permissions) continue;
    for (const r of settings.permissions.allow ?? []) allow.push(r);
    for (const r of settings.permissions.deny ?? []) deny.push(r);
  }
  cachedRules = { allow, deny };
  return cachedRules;
}

export function refreshPermissionRules() {
  cachedRules = null;
  return loadPermissionRules();
}

// ─── 统一入口：返回 { action: "allow"|"deny"|"confirm", message? } ────────
// 优先级：deny 规则 > plan 契约 > bypass > allow 规则 > 模式/危险检测 > 默认允许

export function checkPermission(toolName, input, mode = "default", planFilePath) {
  const rules = loadPermissionRules();
  return createPermissionPolicy(rules).evaluate(toolName, input, { mode, planFilePath });
}
