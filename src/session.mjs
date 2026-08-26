// ============================================================================
// ch4 · 会话持久化（对应教程 04-cli-session.md）
// ============================================================================
// 朴素版：会话 = 一个消息数组，存盘就是写 JSON，恢复就是读回来。
// （真实产品用 JSONL 追加式事件日志 + 重放，见 s08；这里保持 ch4 的最小形态。）

import { writeFileSync, readFileSync, mkdirSync, readdirSync, existsSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const SESSION_DIR = path.join(os.homedir(), ".mini-claude", "sessions");

function ensureDir() {
  try { mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
}

export function saveSession(id, data) {
  try {
    ensureDir();
    writeFileSync(path.join(SESSION_DIR, `${id}.json`), JSON.stringify(data, null, 2), "utf-8");
  } catch { /* 保存失败静默忽略 —— 不能因为磁盘满让对话崩溃 */ }
}

export function loadSession(id) {
  try {
    if (!existsSync(path.join(SESSION_DIR, `${id}.json`))) return null;
    return JSON.parse(readFileSync(path.join(SESSION_DIR, `${id}.json`), "utf-8"));
  } catch { return null; }
}

export function listSessions() {
  try {
    if (!existsSync(SESSION_DIR)) return [];
    return readdirSync(SESSION_DIR)
      .filter((f) => f.endsWith(".json"))
      .map((f) => {
        const data = loadSession(f.slice(0, -".json".length));
        return data?.metadata ?? { id: f.slice(0, -".json".length), startTime: "" };
      });
  } catch { return []; }
}

export function getLatestSessionId() {
  const sessions = listSessions();
  if (sessions.length === 0) return null;
  sessions.sort((a, b) => new Date(b.startTime || 0).getTime() - new Date(a.startTime || 0).getTime());
  return sessions[0].id;
}
