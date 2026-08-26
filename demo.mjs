#!/usr/bin/env node

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Agent } from "./src/agent.mjs";
import { createPermissionPolicy } from "./src/permissions.mjs";
import { SkillRegistry } from "./src/skills.mjs";
import { TraceRecorder } from "./src/trace.mjs";

const traceDir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-demo-"));

try {
  console.log("\n=== 1. 声明式权限：deny 在 --yolo 下仍优先 ===");
  const policy = createPermissionPolicy({
    deny: [{ tool: "run_shell", pattern: "git push*", reason: "演示：远端推送需要人工确认" }],
  });
  console.log(policy.evaluate(
    "run_shell",
    { command: "git push origin main" },
    { mode: "bypassPermissions" },
  ));

  console.log("\n=== 2. Skills：发现元数据，调用时加载正文 ===");
  const registry = new SkillRegistry({
    userDir: path.join(traceDir, "no-user-skills"),
    projectDir: path.join(process.cwd(), ".claude", "skills"),
  });
  console.log(registry.list().map(({ name, description, context }) => ({ name, description, context })));
  console.log(registry.resolve("/review src/trace.mjs"));

  console.log("\n=== 3. Agent Loop：mock 模型 + 工具 + Trace ===");
  const trace = new TraceRecorder({ sessionId: "demo", dir: traceDir });
  const agent = new Agent({
    mock: true,
    isSubAgent: true,
    customSystemPrompt: "Mini Claude Code demo",
    traceRecorder: trace,
    skillRegistry: registry,
  });
  const result = await agent.runOnce("读取 greeting.txt");
  console.log(result.text.trim());
  console.log("\n" + trace.formatRecent(8));
  console.log("\n演示完成：整个过程不需要 API Key。");
} finally {
  fs.rmSync(traceDir, { recursive: true, force: true });
}
