/**
 * server.mjs — 零依赖静态文件服务器（node:http + node:fs/promises）
 *
 * - ROOT 固定为自身所在目录（examples/task-board），天然限定服务范围
 * - 路径穿越防护：normalize 后必须仍在 ROOT 内，否则 403
 * - 目录请求回退到 index.html；未知扩展名回退 application/octet-stream
 * - 端口：环境变量 PORT，缺省 3001
 *
 * 启动：node server.mjs   （或 PORT=8080 node server.mjs）
 */
import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3001;

const MIME_TYPES = Object.freeze({
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
});

function contentType(filePath) {
  return MIME_TYPES[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  const buf = Buffer.from(body, "utf8");
  res.writeHead(status, {
    "Content-Type": type,
    "Content-Length": buf.length,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(buf);
}

const server = http.createServer(async (req, res) => {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    res.writeHead(405, {
      "Content-Type": "text/plain; charset=utf-8",
      Allow: "GET, HEAD",
    });
    res.end("Method Not Allowed");
    return;
  }

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  } catch {
    send(res, 400, "Bad Request");
    return;
  }

  // 路径穿越防护
  const target = path.normalize(path.join(ROOT, pathname));
  const inside = target === ROOT || target.startsWith(ROOT + path.sep);
  if (!inside) {
    send(res, 403, "Forbidden");
    return;
  }

  // 目录 → index.html
  let filePath = target;
  try {
    let info = await stat(filePath);
    if (info.isDirectory()) {
      filePath = path.join(filePath, "index.html");
      info = await stat(filePath);
    }
    if (!info.isFile()) {
      send(res, 404, "Not Found");
      return;
    }
  } catch {
    send(res, 404, "Not Found");
    return;
  }

  try {
    const body = await readFile(filePath);
    const headers = {
      "Content-Type": contentType(filePath),
      "Content-Length": body.length,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    res.writeHead(200, headers);
    res.end(method === "HEAD" ? undefined : body);
  } catch {
    send(res, 500, "Internal Server Error");
  }
});

server.listen(PORT, () => {
  console.log(`Task Board 已启动: http://localhost:${PORT}/`);
  console.log(`Serving: ${ROOT}`);
});
