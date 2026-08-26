/**
 * task-store.mjs — 零依赖任务状态管理核心
 *
 * - 纯 ESM：顶层不依赖任何 node:* 模块、DOM 或全局 API
 * - 同一份代码可在浏览器 <script type="module"> 与 Node.js ESM 中运行
 * - storage 可注入（仅需 getItem / setItem / removeItem），
 *   默认 createDefaultStorage()：浏览器用 localStorage，Node 回退内存 Map
 * - 持久化使用版本信封 { version: 1, tasks: [...] }
 * - 损坏数据（非法 JSON / 版本不符 / 非数组 / 无效条目）降级为空并记录 lastError，不崩溃
 */

export const STORAGE_KEY = "task-board:v1";

const CODE = Object.freeze({
  INVALID_TITLE: "INVALID_TITLE",
  TASK_NOT_FOUND: "TASK_NOT_FOUND",
  INVALID_STORAGE: "INVALID_STORAGE",
});

let idCounter = 0;

/** 生成唯一 id：优先 crypto.randomUUID，回退 时间戳+计数器+随机后缀 */
function generateId() {
  const cryptoObj = globalThis.crypto;
  if (cryptoObj && typeof cryptoObj.randomUUID === "function") {
    return `task_${cryptoObj.randomUUID()}`;
  }
  idCounter += 1;
  const stamp = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 10);
  return `task_${stamp}_${idCounter.toString(36)}_${rand}`;
}

function isBlankTitle(value) {
  return typeof value !== "string" || value.trim() === "";
}

/** 创建带 code 属性的错误 */
function codedError(message, code, ErrorCtor = Error) {
  const err = new ErrorCtor(message);
  err.code = code;
  return err;
}

/** 深拷贝纯数据（Task 均为基本类型字段，JSON 往返足够且跨环境安全） */
function deepCopy(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 内存 storage：闭包 Map，模拟 localStorage 的字符串语义 */
export function createMemoryStorage() {
  const map = new Map();
  return {
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    },
  };
}

/** 默认 storage：浏览器用 localStorage（探测可用性），Node 或不可用时回退内存 */
export function createDefaultStorage() {
  if (typeof globalThis.localStorage !== "undefined") {
    try {
      const probe = "task-board:probe";
      globalThis.localStorage.setItem(probe, "1");
      globalThis.localStorage.removeItem(probe);
      return globalThis.localStorage;
    } catch {
      // localStorage 不可用（隐私模式 / file:// 限制），回退内存
    }
  }
  return createMemoryStorage();
}

/** 归一化单条持久化任务；无法修复的条目返回 null（将被丢弃） */
function sanitizeTask(raw, now) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id : generateId();
  const title = typeof raw.title === "string" ? raw.title.trim() : "";
  if (!title) return null;
  const completed = typeof raw.completed === "boolean" ? raw.completed : false;
  const createdAt = typeof raw.createdAt === "string" ? raw.createdAt : now();
  const updatedAt = typeof raw.updatedAt === "string" ? raw.updatedAt : createdAt;
  return { id, title, completed, createdAt, updatedAt };
}

/**
 * 读取并清洗持久化数据。
 * 返回 { tasks, error }；任何损坏都降级为空数组并把原因放进 error（无损坏时为 null）。
 */
function loadTasks(storage, key, now) {
  let raw;
  try {
    raw = storage.getItem(key);
  } catch (err) {
    return { tasks: [], error: err };
  }
  if (raw === null || raw === undefined) {
    return { tasks: [], error: null };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { tasks: [], error: err };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || parsed.version !== 1) {
    return { tasks: [], error: new Error("unsupported envelope version or shape") };
  }
  if (!Array.isArray(parsed.tasks)) {
    return { tasks: [], error: new Error("envelope tasks is not an array") };
  }

  const tasks = [];
  let dropped = 0;
  for (const item of parsed.tasks) {
    const clean = sanitizeTask(item, now);
    if (clean) tasks.push(clean);
    else dropped += 1;
  }
  return { tasks, error: dropped > 0 ? new Error(`${dropped} invalid task(s) dropped`) : null };
}

/**
 * 创建任务存储。
 * @param {object} [options]
 * @param {object} [options.storage]  可注入 storage，缺省 createDefaultStorage()
 * @param {string} [options.key]      持久化 key，缺省 STORAGE_KEY
 * @param {() => string} [options.now] 返回 ISO 时间字符串，缺省 new Date().toISOString()
 */
export function createTaskStore({ storage, key = STORAGE_KEY, now = () => new Date().toISOString() } = {}) {
  const target = storage ?? createDefaultStorage();
  for (const method of ["getItem", "setItem", "removeItem"]) {
    if (typeof target[method] !== "function") {
      throw codedError(`storage.${method} must be a function`, CODE.INVALID_STORAGE, TypeError);
    }
  }

  let lastError = null;
  const listeners = new Set();

  const loaded = loadTasks(target, key, now);
  let tasks = loaded.tasks;
  lastError = loaded.error;

  /** 写入 storage；失败时保留内存态并记录 lastError，成功则清零 */
  function persist() {
    try {
      target.setItem(key, JSON.stringify({ version: 1, tasks }));
      lastError = null;
    } catch (err) {
      lastError = err;
    }
  }

  /** 通知所有订阅者最新快照；监听器异常不影响状态管理 */
  function emit() {
    const snapshot = deepCopy(tasks);
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // 忽略监听器异常
      }
    }
  }

  function indexOf(id) {
    return tasks.findIndex((t) => t.id === id);
  }

  function requireIndex(id) {
    const idx = indexOf(id);
    if (idx === -1) {
      throw codedError(`task not found: ${id}`, CODE.TASK_NOT_FOUND);
    }
    return idx;
  }

  function commit(nextTasks) {
    tasks = nextTasks;
    persist();
    emit();
  }

  const store = {
    /** 最近一次读写 storage 的错误；正常为 null */
    get lastError() {
      return lastError;
    },

    /** 新增任务；空/空白标题抛 INVALID_TITLE（TypeError） */
    add(title) {
      if (isBlankTitle(title)) {
        throw codedError("title must be a non-empty string", CODE.INVALID_TITLE, TypeError);
      }
      const task = {
        id: generateId(),
        title: title.trim(),
        completed: false,
        createdAt: now(),
        updatedAt: now(),
      };
      commit([...tasks, task]);
      return { ...task };
    },

    /** 修改标题（保留完成状态与顺序）；空标题抛 INVALID_TITLE，不存在抛 TASK_NOT_FOUND */
    edit(id, title) {
      if (isBlankTitle(title)) {
        throw codedError("title must be a non-empty string", CODE.INVALID_TITLE, TypeError);
      }
      const idx = requireIndex(id);
      const updated = { ...tasks[idx], title: title.trim(), updatedAt: now() };
      const next = tasks.slice();
      next[idx] = updated;
      commit(next);
      return { ...updated };
    },

    /** 切换完成状态；不存在抛 TASK_NOT_FOUND */
    toggle(id) {
      const idx = requireIndex(id);
      const updated = { ...tasks[idx], completed: !tasks[idx].completed, updatedAt: now() };
      const next = tasks.slice();
      next[idx] = updated;
      commit(next);
      return { ...updated };
    },

    /** 删除任务并返回被删项；不存在抛 TASK_NOT_FOUND */
    remove(id) {
      const idx = requireIndex(id);
      const removed = tasks[idx];
      const next = tasks.slice();
      next.splice(idx, 1);
      commit(next);
      return { ...removed };
    },

    /** 清空已完成任务，返回删除数量 */
    clearCompleted() {
      const remaining = tasks.filter((t) => !t.completed);
      const removedCount = tasks.length - remaining.length;
      if (removedCount > 0) commit(remaining);
      return removedCount;
    },

    /** 按视图筛选：all | active | completed；非法值回退 all；返回深拷贝 */
    filter(view = "all") {
      let normalized = view;
      if (normalized !== "all" && normalized !== "active" && normalized !== "completed") {
        normalized = "all";
      }
      let result = tasks;
      if (normalized === "active") result = tasks.filter((t) => !t.completed);
      if (normalized === "completed") result = tasks.filter((t) => t.completed);
      return deepCopy(result);
    },

    /** 全部任务（深拷贝），等价于 filter("all") */
    list() {
      return deepCopy(tasks);
    },

    /** 统计信息 { total, active, completed } */
    stats() {
      let active = 0;
      let completed = 0;
      for (const t of tasks) {
        if (t.completed) completed += 1;
        else active += 1;
      }
      return { total: tasks.length, active, completed };
    },

    /** 订阅变更；返回退订函数。每次变更后收到最新快照（深拷贝） */
    subscribe(listener) {
      if (typeof listener !== "function") {
        throw new TypeError("listener must be a function");
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return store;
}
