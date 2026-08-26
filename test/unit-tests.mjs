#!/usr/bin/env node
// ============================================================================
// ch14 · 自动化单元测试（确定性部分，无需 API key）
// 覆盖：权限 / 工具 / 技能 / 记忆 / 子 Agent / frontmatter / 上下文
// 运行：node test/unit-tests.mjs
// ============================================================================

import { createPermissionPolicy, isDangerous } from "../src/permissions.mjs";
import { executeTool, toolDefinitions } from "../src/tools.mjs";
import { resolveSkill } from "../src/skills.mjs";
import { parseFrontmatter, formatFrontmatter } from "../src/frontmatter.mjs";
import { getSubAgentConfig, getGeneralToolDefs } from "../src/subagent.mjs";
import { persistLargeResult, maybeCompact } from "../src/context.mjs";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log(`  ✅ ${name}`); } else { fail++; console.log(`  ❌ ${name}`); } };

const ctx = { readFileState: new Map(), permissionMode: "default", registrar: { activated: new Set() } };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mini-claude-test-"));
const planFile = path.join(tmp, "plan.md");
const baselinePolicy = createPermissionPolicy();
const checkBaselinePermission = (tool, input, mode, currentPlanFile) =>
  baselinePolicy.evaluate(tool, input, { mode, planFilePath: currentPlanFile });

console.log("=== 权限（ch6/ch10）===");
check("isDangerous: rm -rf", isDangerous("rm -rf /tmp"));
check("isDangerous: git push", isDangerous("git push origin main"));
check("isDangerous: npm test 不是", !isDangerous("npm test"));
check("rm -rf 默认 confirm", checkBaselinePermission("run_shell", { command: "rm -rf /tmp" }, "default").action === "confirm");
check("rm -rf --yolo 放行", checkBaselinePermission("run_shell", { command: "rm -rf /tmp" }, "bypassPermissions").action === "allow");
check("plan 模式写文件 deny", checkBaselinePermission("write_file", { file_path: "a.js" }, "plan", planFile).action === "deny");
check("plan 模式写 plan 文件 allow", checkBaselinePermission("write_file", { file_path: planFile }, "plan", planFile).action === "allow");
check("plan 模式 shell deny", checkBaselinePermission("run_shell", { command: "ls" }, "plan").action === "deny");
check("plan 模式读 allow", checkBaselinePermission("read_file", { file_path: "a.js" }, "plan").action === "allow");
check("dontAsk 危险 deny", checkBaselinePermission("run_shell", { command: "sudo x" }, "dontAsk").action === "deny");

console.log("=== 工具（ch2）===");
const f = path.join(tmp, "t.txt");
fs.writeFileSync(f, "hello world\nsecond line");
check("read_file 带行号", (await executeTool("read_file", { file_path: f }, ctx)).startsWith("   1 | hello"));
check("edit 唯一匹配", (await executeTool("edit_file", { file_path: f, old_string: "hello", new_string: "hi" }, ctx)).startsWith("Successfully edited"));
fs.writeFileSync(f, "a b a b");
// 外部改文件后必须重新 read 刷新 mtime，否则触发的是"外部修改"防护而不是唯一匹配
await executeTool("read_file", { file_path: f }, ctx);
check("edit 多匹配拒绝", (await executeTool("edit_file", { file_path: f, old_string: "a", new_string: "X" }, ctx)).includes("Must be unique"));
check("read-before-edit 拒绝", (await executeTool("write_file", { file_path: f, content: "x" }, { ...ctx, readFileState: new Map() })).includes("must read this file"));
const newFile = path.join(tmp, "nested", "new.txt");
check("write 新文件自动建目录", (await executeTool("write_file", { file_path: newFile, content: "ok" }, ctx)).startsWith("Successfully wrote"));
check("list_files glob", (await executeTool("list_files", { pattern: "*.mjs", path: "src" }, ctx)).includes("agent.mjs"));
check("grep 单文件", (await executeTool("grep_search", { pattern: "export class", path: "src/agent.mjs" }, ctx)).includes("agent.mjs"));

console.log("=== 技能（ch9）===");
const skills = toolDefinitions.map((t) => t.function.name);
check("skill 工具在注册表", skills.includes("skill"));
check("agent 工具在注册表", skills.includes("agent"));

console.log("=== frontmatter（ch8/9）===");
const fm = parseFrontmatter("---\nname: test\ntype: project\n---\nbody text");
check("frontmatter 解析", fm.meta.name === "test" && fm.meta.type === "project" && fm.body === "body text");
check("frontmatter 格式化往返", parseFrontmatter(formatFrontmatter({ name: "x" }, "b")).meta.name === "x");

console.log("=== 子 Agent（ch11）===");
const e = getSubAgentConfig("explore");
check("explore 只读工具", e.tools.every((t) => ["read_file", "list_files", "grep_search"].includes(t.function.name)));
check("general 不含 agent", !getGeneralToolDefs().some((t) => t.function.name === "agent"));

console.log("=== 上下文（ch7）===");
const big = "x".repeat(40 * 1024);
const toolResultDir = path.join(tmp, "tool-results");
const persisted = persistLargeResult("read_file", big, { outputDir: toolResultDir });
check("大结果持久化", persisted.includes("Full output saved")
  && fs.readdirSync(toolResultDir).length === 1);
const short = "small";
check("小结果不持久化", persistLargeResult("read_file", short, { outputDir: toolResultDir }) === short);
const many = [];
for (let i = 0; i < 20; i++) many.push({ role: "user", content: `msg ${i}` });
const compacted = await maybeCompact(many, async () => "摘要");
check("maybeCompact 超阈值压缩", compacted.length < many.length && compacted[0].content.includes("上下文压缩"));

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = fail > 0 ? 1 : 0;
