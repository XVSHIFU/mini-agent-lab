// ============================================================================
// 08 · 本地可观测性：零依赖 JSONL Trace
// ============================================================================
// 每行一个完整事件；写入失败不会打断 Agent 主流程。
// 默认只在用户目录保存本地调试信息，并在落盘前递归隐藏敏感字段。
// ============================================================================

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const SENSITIVE_KEYS = new Set([
  "apikey",
  "authorization",
  "cookie",
  "password",
  "secret",
  "token",
  "accesstoken",
  "refreshtoken",
  "clientsecret",
]);
const TOKEN_USAGE_KEYS = new Set([
  "prompttokens",
  "completiontokens",
  "totaltokens",
  "inputtokens",
  "outputtokens",
  "cachedtokens",
  "reasoningtokens",
]);
const MAX_STRING_LENGTH = 2_000;

function isSensitiveKey(key) {
  const normalized = String(key).replace(/[-_]/g, "").toLowerCase();
  if (TOKEN_USAGE_KEYS.has(normalized)) return false;
  return (
    SENSITIVE_KEYS.has(normalized) ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("apikey")
  );
}

function sanitizeString(value) {
  const redacted = value
    .replace(/(Bearer\s+)[a-zA-Z0-9._~+\/=:-]+/gi, "$1[REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(
      /(\b(?:api[-_]?key|password|secret|token)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s'"]+)/gi,
      "$1[REDACTED]",
    );
  return redacted.length > MAX_STRING_LENGTH
    ? `${redacted.slice(0, MAX_STRING_LENGTH)}…[truncated ${redacted.length - MAX_STRING_LENGTH} chars]`
    : redacted;
}

function sanitize(value, key = "", seen = new WeakSet()) {
  if (isSensitiveKey(key)) return "[REDACTED]";
  if (typeof value === "string") return sanitizeString(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, "", seen));

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = sanitize(childValue, childKey, seen);
  }
  return result;
}

export class TraceRecorder {
  constructor({
    sessionId,
    dir = join(homedir(), ".mini-claude", "traces"),
    enabled = true,
    clock = () => new Date(),
  } = {}) {
    this.sessionId = sessionId || `ses_${Date.now().toString(36)}`;
    this.dir = dir;
    this.enabled = enabled;
    this.clock = clock;
    this.seq = 0;
    this.lastError = null;
    const safeId = this.sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
    this.path = join(this.dir, `trace-${safeId}.jsonl`);
  }

  record(type, data = {}) {
    if (!this.enabled) return null;
    const event = {
      timestamp: this.clock().toISOString(),
      seq: ++this.seq,
      sessionId: this.sessionId,
      type,
      data: sanitize(data),
    };
    try {
      mkdirSync(this.dir, { recursive: true });
      appendFileSync(this.path, `${JSON.stringify(event)}\n`, "utf-8");
      return event;
    } catch (error) {
      this.lastError = error;
      return null;
    }
  }

  recent(limit = 20) {
    if (!existsSync(this.path)) return [];
    try {
      return readFileSync(this.path, "utf-8")
        .split(/\r?\n/)
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .slice(-Math.max(0, limit));
    } catch (error) {
      this.lastError = error;
      return [];
    }
  }

  formatRecent(limit = 20) {
    const events = this.recent(limit);
    if (events.length === 0) return `Trace: ${this.path}\n(no events)`;
    const lines = [`Trace: ${this.path}`];
    for (const event of events) {
      const details = JSON.stringify(event.data);
      lines.push(`#${event.seq} ${event.type} ${details}`);
    }
    return lines.join("\n");
  }
}
