// ============================================================================
// ch8/ch9 · frontmatter 解析（记忆和技能共用）
// ============================================================================
// 记忆文件（*.md）和技能文件（SKILL.md）都用 YAML frontmatter 头部：
//   ---
//   name: xxx
//   description: xxx
//   type: feedback
//   ---
//   <正文>
// 没有用 js-yaml——frontmatter 只是简单的 key: value，手写 20 行够用且零依赖。

export function parseFrontmatter(content) {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { meta: {}, body: content };

  let endIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") { endIdx = i; break; }
  }
  if (endIdx === -1) return { meta: {}, body: content };

  const meta = {};
  for (let i = 1; i < endIdx; i++) {
    const colonIdx = lines[i].indexOf(":");
    if (colonIdx === -1) continue;
    const key = lines[i].slice(0, colonIdx).trim();
    const value = lines[i].slice(colonIdx + 1).trim();
    if (key) meta[key] = value;
  }

  const body = lines.slice(endIdx + 1).join("\n").trim();
  return { meta, body };
}

export function formatFrontmatter(meta, body) {
  const head = Object.entries(meta)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  return `---\n${head}\n---\n${body}`;
}

// slugify：中文保留、空格/特殊字符转下划线（用于文件名）
export function slugify(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60) || "untitled";
}
