/**
 * task-store.test.mjs — task-store.mjs 的 node:test 自动化测试
 *
 * 全部用例使用内存 storage + 固定/可控时钟注入，保证确定性。
 * 运行：node --test examples/task-board/test/task-store.test.mjs
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createTaskStore, createMemoryStorage, createDefaultStorage, STORAGE_KEY } from "../task-store.mjs";

const FIXED_NOW = () => "2026-08-23T00:00:00.000Z";

/** 可控时钟：now() 返回 ISO 字符串，advance() 推进时间 */
function makeClock(start = "2026-01-01T00:00:00.000Z") {
  let ms = Date.parse(start);
  return {
    now: () => new Date(ms).toISOString(),
    advance: (step = 1000) => {
      ms += step;
    },
  };
}

/** 便捷创建：预置内存 storage，可选预埋任务数据 */
function makeStore({ seed, now = FIXED_NOW, key = STORAGE_KEY } = {}) {
  const storage = createMemoryStorage();
  if (seed) storage.setItem(key, JSON.stringify({ version: 1, tasks: seed }));
  const store = createTaskStore({ storage, key, now });
  return { store, storage };
}

/** 读取 storage 中持久化的任务数组 */
function storedTasks(storage, key = STORAGE_KEY) {
  const raw = storage.getItem(key);
  return raw ? JSON.parse(raw).tasks : null;
}

function assertInvalidTitle(fn) {
  assert.throws(fn, (err) => err instanceof TypeError && err.code === "INVALID_TITLE");
}

function assertNotFound(fn) {
  assert.throws(fn, (err) => err instanceof Error && err.code === "TASK_NOT_FOUND");
}

/* ─────────────────────────── 新增 ─────────────────────────── */

test("add: 创建合法任务并返回（id 前缀、初始未完成、时间戳）", () => {
  const { store } = makeStore();
  const task = store.add("  写周报  ");
  assert.match(task.id, /^task_/);
  assert.equal(task.title, "写周报"); // 去除首尾空白
  assert.equal(task.completed, false);
  assert.equal(task.createdAt, FIXED_NOW());
  assert.equal(task.updatedAt, FIXED_NOW());
  assert.equal(store.list().length, 1);
});

test("add: 连续多次 id 唯一", () => {
  const { store } = makeStore();
  const ids = [store.add("a").id, store.add("b").id, store.add("c").id];
  assert.equal(new Set(ids).size, 3);
});

test("add: 空/空白标题抛 INVALID_TITLE，列表不受影响", () => {
  const { store } = makeStore();
  for (const bad of ["", "   ", "\t\n ", 42, null, undefined]) {
    assertInvalidTitle(() => store.add(bad));
  }
  assert.equal(store.list().length, 0);
});

test("add: 自动持久化到 storage", () => {
  const { store, storage } = makeStore();
  store.add("持久化任务");
  const tasks = storedTasks(storage);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].title, "持久化任务");
});

test("add: 统计同步", () => {
  const { store } = makeStore();
  store.add("t1");
  store.add("t2");
  store.add("t3");
  assert.deepEqual(store.stats(), { total: 3, active: 3, completed: 0 });
});

/* ─────────────────────────── 编辑 ─────────────────────────── */

test("edit: 改标题保留完成状态与顺序，更新时间戳", () => {
  const clock = makeClock();
  const { store } = makeStore({ now: clock.now });
  const a = store.add("a");
  const b = store.add("b");
  store.toggle(b.id);
  clock.advance(5000);

  const edited = store.edit(a.id, "A 修改后");
  assert.equal(edited.title, "A 修改后");
  assert.equal(edited.completed, false);
  assert.equal(edited.updatedAt, clock.now());
  assert.notEqual(edited.updatedAt, edited.createdAt);

  const all = store.list();
  assert.deepEqual(all.map((t) => t.id), [a.id, b.id]); // 顺序保留
  assert.equal(all[1].completed, true); // b 的完成状态保留
});

test("edit: 空标题被拒且原值不变", () => {
  const { store } = makeStore();
  const a = store.add("原始标题");
  for (const bad of ["", "   "]) {
    assertInvalidTitle(() => store.edit(a.id, bad));
  }
  assert.equal(store.list()[0].title, "原始标题");
});

test("edit: 不存在的 id 抛 TASK_NOT_FOUND", () => {
  const { store } = makeStore();
  assertNotFound(() => store.edit("task_nope", "x"));
});

test("edit: 持久化同步", () => {
  const { store, storage } = makeStore();
  const a = store.add("a");
  store.edit(a.id, "b");
  assert.equal(storedTasks(storage)[0].title, "b");
});

/* ─────────────────────────── 完成切换 ─────────────────────────── */

test("toggle: 翻转且可往返，更新时间戳", () => {
  const clock = makeClock();
  const { store } = makeStore({ now: clock.now });
  const a = store.add("a");
  clock.advance(1000);
  const once = store.toggle(a.id);
  assert.equal(once.completed, true);
  assert.equal(once.updatedAt, clock.now());
  assert.equal(store.toggle(a.id).completed, false);
});

test("toggle: 统计联动", () => {
  const { store } = makeStore();
  const a = store.add("a");
  const b = store.add("b");
  store.toggle(a.id);
  assert.deepEqual(store.stats(), { total: 2, active: 1, completed: 1 });
});

test("toggle: 不存在的 id 抛 TASK_NOT_FOUND", () => {
  const { store } = makeStore();
  assertNotFound(() => store.toggle("task_missing"));
});

test("toggle: 持久化同步", () => {
  const { store, storage } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  assert.equal(storedTasks(storage)[0].completed, true);
});

/* ─────────────────────────── 删除 ─────────────────────────── */

test("remove: 删除后列表与 storage 同步，返回被删项", () => {
  const { store, storage } = makeStore();
  const a = store.add("a");
  const b = store.add("b");
  const removed = store.remove(a.id);
  assert.equal(removed.id, a.id);
  assert.deepEqual(store.list().map((t) => t.id), [b.id]);
  assert.deepEqual(storedTasks(storage).map((t) => t.id), [b.id]);
});

test("remove: 不存在的 id 抛 TASK_NOT_FOUND", () => {
  const { store } = makeStore();
  assertNotFound(() => store.remove("task_missing"));
});

test("remove: 统计同步", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  store.remove(a.id);
  assert.deepEqual(store.stats(), { total: 0, active: 0, completed: 0 });
});

/* ─────────────────────────── 清空已完成 ─────────────────────────── */

test("clearCompleted: 只删已完成并返回数量", () => {
  const { store } = makeStore();
  const a = store.add("a");
  const b = store.add("b");
  const c = store.add("c");
  store.toggle(a.id);
  store.toggle(c.id);
  assert.equal(store.clearCompleted(), 2);
  assert.deepEqual(store.list().map((t) => t.title), ["b"]);
});

test("clearCompleted: 无已完成返回 0，列表不变", () => {
  const { store } = makeStore();
  store.add("a");
  store.add("b");
  assert.equal(store.clearCompleted(), 0);
  assert.equal(store.list().length, 2);
});

test("clearCompleted: 统计与持久化正确", () => {
  const { store, storage } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  store.add("b");
  store.clearCompleted();
  assert.deepEqual(store.stats(), { total: 1, active: 1, completed: 0 });
  assert.deepEqual(storedTasks(storage).map((t) => t.title), ["b"]);
});

/* ─────────────────────────── 筛选 ─────────────────────────── */

test("filter: all/active/completed 各自正确", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.add("b");
  const c = store.add("c");
  store.toggle(a.id);
  store.toggle(c.id);
  assert.equal(store.filter("all").length, 3);
  assert.deepEqual(store.filter("active").map((t) => t.title), ["b"]);
  assert.deepEqual(store.filter("completed").map((t) => t.title), ["a", "c"]);
});

test("filter: 返回快照，修改结果不影响内部", () => {
  const { store } = makeStore();
  store.add("a");
  const snapshot = store.filter("all");
  snapshot[0].title = "被外部篡改";
  snapshot[0].completed = true;
  assert.equal(store.list()[0].title, "a");
  assert.equal(store.list()[0].completed, false);
});

test("filter: 默认 all", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  assert.equal(store.filter().length, 1);
  assert.equal(store.filter(undefined).length, 1);
});

test("filter: 非法值回退 all", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  for (const bad of ["xxx", "", "Active", 42, null]) {
    assert.equal(store.filter(bad).length, 1);
  }
});

test("filter: 不改变统计", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  store.filter("active");
  store.filter("completed");
  assert.deepEqual(store.stats(), { total: 1, active: 0, completed: 1 });
});

test("list: 等价 filter('all') 且返回深拷贝", () => {
  const { store } = makeStore();
  store.add("a");
  const l = store.list();
  l[0].title = "改";
  assert.equal(store.list()[0].title, "a");
  assert.deepEqual(store.list(), store.filter("all"));
});

/* ─────────────────────────── 统计 ─────────────────────────── */

test("stats: 初始 0/0/0", () => {
  const { store } = makeStore();
  assert.deepEqual(store.stats(), { total: 0, active: 0, completed: 0 });
});

test("stats: 增删切换联动", () => {
  const { store } = makeStore();
  const a = store.add("a");
  const b = store.add("b");
  const c = store.add("c");
  store.toggle(a.id);
  store.toggle(b.id);
  assert.deepEqual(store.stats(), { total: 3, active: 1, completed: 2 });
  store.remove(a.id);
  assert.deepEqual(store.stats(), { total: 2, active: 1, completed: 1 });
});

test("stats: 与筛选视图无关", () => {
  const { store } = makeStore();
  const a = store.add("a");
  store.toggle(a.id);
  store.filter("active");
  assert.deepEqual(store.stats(), { total: 1, active: 0, completed: 1 });
});

/* ─────────────────────────── 持久化恢复（模拟刷新） ─────────────────────────── */

test("持久化恢复: 同一 storage 新建 store，任务/顺序/统计完全恢复", () => {
  const storage = createMemoryStorage();
  const s1 = createTaskStore({ storage, now: FIXED_NOW });
  const a = s1.add("买牛奶");
  const b = s1.add("写周报");
  const c = s1.add("健身");
  s1.toggle(b.id);
  s1.toggle(c.id);
  s1.edit(a.id, "买脱脂牛奶");

  const s2 = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(s2.list().map((t) => t.title), ["买脱脂牛奶", "写周报", "健身"]);
  assert.deepEqual(s2.list().map((t) => t.completed), [false, true, true]);
  assert.deepEqual(s2.stats(), { total: 3, active: 1, completed: 2 });
  assert.equal(s2.list()[0].id, a.id);
  assert.equal(s2.list()[2].id, c.id);
  assert.equal(s2.lastError, null); // 干净数据不产生错误
});

/* ─────────────────────────── 损坏数据处理 ─────────────────────────── */

test("损坏数据: 非法 JSON 降级为空并记录 lastError，写操作仍正常", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, "{oops not json");
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(store.list(), []);
  assert.ok(store.lastError instanceof Error);
  store.add("新任务");
  assert.equal(store.list().length, 1);
});

test("损坏数据: 非对象/版本不符降级为空", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 999, tasks: [{ id: "t", title: "x" }] }));
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(store.list(), []);
  assert.ok(store.lastError);
});

test("损坏数据: tasks 非数组降级为空", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: "not-an-array" }));
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(store.list(), []);
  assert.ok(store.lastError);
});

test("损坏数据: 缺字段归一化、无效条目丢弃", () => {
  const storage = createMemoryStorage();
  storage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      version: 1,
      tasks: [
        { id: "task_1", title: "缺字段", completed: true }, // 补时间戳
        { title: 42 }, // 标题非字符串 → 丢弃
        { id: "task_2", title: "   " }, // 空白标题 → 丢弃
        null, // 非对象 → 丢弃
      ],
    })
  );
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.equal(store.list().length, 1);
  const t = store.list()[0];
  assert.equal(t.id, "task_1");
  assert.equal(t.completed, true);
  assert.equal(typeof t.createdAt, "string");
  assert.equal(t.updatedAt, t.createdAt);
  assert.ok(store.lastError); // 有丢弃即记录
});

test("损坏数据: 空数组正常为空，无 lastError", () => {
  const storage = createMemoryStorage();
  storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tasks: [] }));
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(store.list(), []);
  assert.deepEqual(store.stats(), { total: 0, active: 0, completed: 0 });
  assert.equal(store.lastError, null);
});

/* ─────────────────────────── 降级 ─────────────────────────── */

test("降级: storage 缺方法抛 INVALID_STORAGE", () => {
  assert.throws(() => createTaskStore({ storage: {} }), (err) => err.code === "INVALID_STORAGE");
  assert.throws(
    () => createTaskStore({ storage: { getItem() {} } }),
    (err) => err.code === "INVALID_STORAGE"
  );
  assert.throws(
    () => createTaskStore({ storage: { getItem() {}, setItem() {} } }),
    (err) => err.code === "INVALID_STORAGE"
  );
});

test("降级: getItem 抛错不崩溃，保留空态并记录 lastError", () => {
  const storage = createMemoryStorage();
  const realGet = storage.getItem.bind(storage);
  storage.getItem = () => {
    throw new Error("storage read failed");
  };
  const store = createTaskStore({ storage, now: FIXED_NOW });
  assert.deepEqual(store.list(), []);
  assert.ok(store.lastError);
  // 恢复后可正常读写
  storage.getItem = realGet;
  store.add("x");
  assert.equal(store.list().length, 1);
  assert.equal(store.lastError, null); // 成功后错误清零
});

test("降级: setItem 抛错不崩溃，保留内存态并记录 lastError", () => {
  const storage = createMemoryStorage();
  const store = createTaskStore({ storage, now: FIXED_NOW });
  const realSet = storage.setItem.bind(storage);
  storage.setItem = () => {
    throw new Error("quota exceeded");
  };
  const a = store.add("a"); // 内存态保留
  assert.equal(store.list().length, 1);
  assert.ok(store.lastError);
  store.toggle(a.id); // 继续可操作
  assert.equal(store.list()[0].completed, true);
  // 恢复后持久化正常，错误清零
  storage.setItem = realSet;
  store.edit(a.id, "b");
  assert.equal(storedTasks(storage)[0].title, "b");
  assert.equal(store.lastError, null);
});

test("降级: 自定义 key 相互隔离", () => {
  const storage = createMemoryStorage();
  const s1 = createTaskStore({ storage, key: "app:a", now: FIXED_NOW });
  const s2 = createTaskStore({ storage, key: "app:b", now: FIXED_NOW });
  s1.add("A 的任务");
  s2.add("B 的任务");
  assert.deepEqual(s1.list().map((t) => t.title), ["A 的任务"]);
  assert.deepEqual(s2.list().map((t) => t.title), ["B 的任务"]);
  assert.deepEqual(s1.stats(), { total: 1, active: 1, completed: 0 });
  assert.deepEqual(s2.stats(), { total: 1, active: 1, completed: 0 });
});

/* ─────────────────────────── 订阅 ─────────────────────────── */

test("subscribe: 变更后收到最新快照，可退订", () => {
  const { store } = makeStore();
  const seen = [];
  const unsub = store.subscribe((snapshot) => seen.push(snapshot.map((t) => t.title)));
  store.add("a");
  store.add("b");
  unsub();
  store.add("c");
  assert.deepEqual(seen, [["a"], ["a", "b"]]);
  assert.equal(store.list().length, 3); // 退订不影响功能
});

test("subscribe: 快照为深拷贝，篡改不影响内部", () => {
  const { store } = makeStore();
  store.subscribe((snapshot) => {
    snapshot[0].title = "被改";
    snapshot[0].completed = true;
  });
  store.add("原始");
  assert.equal(store.list()[0].title, "原始");
  assert.equal(store.list()[0].completed, false);
});

test("subscribe: 非函数监听器抛 TypeError", () => {
  const { store } = makeStore();
  assert.throws(() => store.subscribe("not a function"), TypeError);
});

/* ─────────────────────────── 默认 storage ─────────────────────────── */

test("createDefaultStorage: Node 环境回退内存 storage 且可用", () => {
  const storage = createDefaultStorage();
  assert.equal(typeof storage.getItem, "function");
  assert.equal(typeof storage.setItem, "function");
  assert.equal(typeof storage.removeItem, "function");
  storage.setItem("k", "v");
  assert.equal(storage.getItem("k"), "v");
  storage.removeItem("k");
  assert.equal(storage.getItem("k"), null);
});
