/**
 * app.js — 浏览器接线层：把 task-store.mjs 的状态渲染到页面。
 *
 * - 业务逻辑全部委托给 store，本文件只做 DOM 渲染与事件绑定
 * - 用户输入一律用 textContent 写入，不使用 innerHTML 拼接，防 XSS
 * - 状态变更（新增/编辑/切换/删除/清空）都经 store.subscribe 触发重渲染
 */
import { createTaskStore } from "./task-store.mjs";

const store = createTaskStore();

const els = {
  form: document.getElementById("task-form"),
  input: document.getElementById("task-input"),
  list: document.getElementById("task-list"),
  filters: Array.from(document.querySelectorAll(".filter-btn")),
  stats: document.getElementById("task-stats"),
  clearCompleted: document.getElementById("clear-completed"),
  empty: document.getElementById("empty-state"),
};

let currentView = "all";

/* ───────────────────────── 渲染 ───────────────────────── */

function render() {
  const tasks = store.filter(currentView);
  const stats = store.stats();

  els.list.textContent = "";
  for (const task of tasks) {
    els.list.appendChild(renderItem(task));
  }

  if (tasks.length === 0) {
    els.empty.hidden = false;
    if (stats.total === 0) {
      els.empty.textContent = "暂无任务，在上方输入框添加第一个任务 🎉";
    } else if (currentView === "completed") {
      els.empty.textContent = "还没有已完成的任务";
    } else {
      els.empty.textContent = "没有进行中的任务，全部完成！🏆";
    }
  } else {
    els.empty.hidden = true;
  }

  els.stats.textContent = `共 ${stats.total} 项 · 未完成 ${stats.active} 项`;
  els.clearCompleted.disabled = stats.completed === 0;

  for (const btn of els.filters) {
    const active = btn.dataset.view === currentView;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  }
}

function renderItem(task) {
  const li = document.createElement("li");
  li.className = `task-item${task.completed ? " completed" : ""}`;
  li.dataset.id = task.id;

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "task-toggle";
  checkbox.checked = task.completed;
  checkbox.setAttribute("aria-label", `标记「${task.title}」为${task.completed ? "未完成" : "已完成"}`);
  checkbox.addEventListener("change", () => store.toggle(task.id));

  const title = document.createElement("span");
  title.className = "task-title";
  title.textContent = task.title;
  title.title = "双击可编辑";

  const editBtn = document.createElement("button");
  editBtn.type = "button";
  editBtn.className = "task-edit";
  editBtn.textContent = "编辑";
  editBtn.setAttribute("aria-label", `编辑「${task.title}」`);

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "task-delete";
  deleteBtn.textContent = "删除";
  deleteBtn.setAttribute("aria-label", `删除「${task.title}」`);

  editBtn.addEventListener("click", () => startEdit(li, task));
  title.addEventListener("dblclick", () => startEdit(li, task));
  deleteBtn.addEventListener("click", () => store.remove(task.id));

  li.append(checkbox, title, editBtn, deleteBtn);
  return li;
}

/* ───────────────────────── 行内编辑 ───────────────────────── */

function startEdit(li, task) {
  const titleEl = li.querySelector(".task-title");
  if (!titleEl) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "task-edit-input";
  input.value = task.title;
  input.maxLength = 200;
  input.setAttribute("aria-label", "编辑任务标题，回车保存，Esc 取消");

  let finished = false;
  const finish = (save) => {
    if (finished) return;
    finished = true;
    input.remove();
    if (save) {
      const value = input.value.trim();
      if (value) store.edit(task.id, value);
      // 空标题：不保存，原标题保留
    }
    render(); // 取消时恢复原标题；保存时订阅也会重渲染，重复无害
  };

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      finish(true);
    } else if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));

  titleEl.replaceWith(input);
  input.focus();
  input.select();
}

/* ───────────────────────── 事件接线 ───────────────────────── */

els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  const title = els.input.value.trim();
  if (!title) {
    els.input.focus();
    return;
  }
  try {
    store.add(title);
    els.input.value = "";
    els.input.focus();
  } catch (err) {
    if (err.code === "INVALID_TITLE") {
      els.input.focus(); // 理论不可达（已 trim 校验），防御性处理
    } else {
      throw err;
    }
  }
});

for (const btn of els.filters) {
  btn.addEventListener("click", () => {
    currentView = btn.dataset.view;
    render();
  });
}

els.clearCompleted.addEventListener("click", () => store.clearCompleted());

store.subscribe(() => render());
render();
