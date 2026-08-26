// ============================================================================
// ch12 · MCP 集成（对应教程 12-mcp.md，从 TS 版移植）
// ============================================================================
// 让 agent 动态挂载外部工具：声明一个服务器地址，就能把数据库、Slack、
// GitHub 的工具接进来，不动一行 agent 代码。
// 核心：spawn 子进程 → JSON-RPC 握手 → 发现工具 → mcp__ 前缀注册 → 透明路由。
// MCP 工具对 Agent Loop 来说和内置工具没有区别——都是名字 + schema + 执行函数。
// ============================================================================

import { spawn } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";

// 单个 MCP 连接（每个服务器一个）：子进程管理 + JSON-RPC 通信
class McpConnection {
  constructor(serverName, config) {
    this.serverName = serverName;
    this.config = config;
    this.process = null;
    this.nextId = 1;
    this.pending = new Map(); // id -> { resolve, reject }
    this.rl = null;
  }

  async connect() {
    const env = { ...process.env, ...(this.config.env || {}) };
    this.process = spawn(this.config.command, this.config.args || [], { stdio: ["pipe", "pipe", "pipe"], env });

    // 按行解析 stdout 里的 JSON-RPC
    this.rl = createInterface({ input: this.process.stdout });
    this.rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          msg.error ? reject(new Error(`MCP error ${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
        }
      } catch { /* 非 JSON 行（服务器日志）忽略 */ }
    });
    this.process.stderr?.on("data", () => {});
    this.process.on("error", (err) => console.error(`[mcp:${this.serverName}] process error: ${err.message}`));
    // 服务器退出 → reject 所有 pending
    this.process.on("exit", (code) => {
      for (const [, { reject }] of this.pending) reject(new Error(`MCP server '${this.serverName}' exited with code ${code}`));
      this.pending.clear();
    });
  }

  sendRequest(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.process?.stdin?.writable) return reject(new Error(`MCP server '${this.serverName}' is not connected`));
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  sendNotification(method, params = {}) {
    if (!this.process?.stdin?.writable) return;
    this.process.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  // 握手：initialize → notifications/initialized → tools/list
  async initialize() {
    await this.sendRequest("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "mini-claude", version: "1.0.0" } });
    this.sendNotification("notifications/initialized");
  }

  async listTools() {
    const result = await this.sendRequest("tools/list");
    if (!result?.tools || !Array.isArray(result.tools)) return [];
    return result.tools.map((t) => ({
      name: t.name, description: t.description || "", inputSchema: t.inputSchema, serverName: this.serverName,
    }));
  }

  // MCP 返回 { content: [{ type: "text", text }, ...] }，只取 text
  async callTool(name, args) {
    const result = await this.sendRequest("tools/call", { name, arguments: args });
    if (result?.content && Array.isArray(result.content)) {
      return result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
    }
    return JSON.stringify(result);
  }

  close() { this.rl?.close(); this.process?.kill(); this.process = null; }
}

// MCP 管理器：加载配置、连接所有服务器、统一接口
export class McpManager {
  constructor() {
    this.connections = new Map();
    this.tools = [];
    this.connected = false;
  }

  loadConfigs() {
    const merged = {};
    const files = [
      join(homedir(), ".claude", "settings.json"),
      join(process.cwd(), ".claude", "settings.json"),
      join(process.cwd(), ".mcp.json"),
    ];
    for (const file of files) this.mergeConfigFile(file, merged);
    return merged;
  }

  mergeConfigFile(filePath, target) {
    if (!existsSync(filePath)) return;
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf-8"));
      const servers = raw.mcpServers || raw; // .mcp.json 可能直接是服务器映射
      for (const [name, config] of Object.entries(servers)) {
        if (config && typeof config === "object" && typeof config.command === "string") target[name] = config;
      }
    } catch { /* 静默跳过格式错误 */ }
  }

  // 幂等：多次调用只连一次；每个服务器独立，一个失败不影响其他
  async loadAndConnect() {
    if (this.connected) return;
    this.connected = true;
    const configs = this.loadConfigs();
    if (Object.keys(configs).length === 0) return;

    const TIMEOUT_MS = 15_000;
    const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms))]);

    for (const [name, config] of Object.entries(configs)) {
      const conn = new McpConnection(name, config);
      try {
        await conn.connect();
        await withTimeout(conn.initialize(), TIMEOUT_MS);
        const serverTools = await withTimeout(conn.listTools(), TIMEOUT_MS);
        this.connections.set(name, conn);
        this.tools.push(...serverTools);
        console.error(`[mcp] Connected to '${name}' — ${serverTools.length} tools`);
      } catch (err) {
        console.error(`[mcp] Failed to connect to '${name}': ${err.message}`);
        conn.close();
      }
    }
  }

  // 三段式前缀：mcp__server__tool（避免冲突 + 嵌入路由信息）
  getToolDefinitions() {
    return this.tools.map((t) => ({
      type: "function",
      function: {
        name: `mcp__${t.serverName}__${t.name}`,
        description: t.description || `MCP tool ${t.name} from ${t.serverName}`,
        parameters: t.inputSchema || { type: "object", properties: {} },
      },
    }));
  }

  isMcpTool(name) { return name.startsWith("mcp__"); }

  async callTool(prefixedName, args) {
    const parts = prefixedName.split("__");
    if (parts.length < 3) throw new Error(`Invalid MCP tool name: ${prefixedName}`);
    const serverName = parts[1];
    const toolName = parts.slice(2).join("__"); // 工具名本身可能含 __
    const conn = this.connections.get(serverName);
    if (!conn) throw new Error(`MCP server '${serverName}' not connected`);
    return conn.callTool(toolName, args);
  }

  disconnectAll() {
    for (const [, conn] of this.connections) conn.close();
    this.connections.clear();
    this.tools = [];
    this.connected = false;
  }
}
