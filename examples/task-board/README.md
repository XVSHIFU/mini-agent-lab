# 离线任务看板（零依赖）

一个**零第三方依赖**的离线任务看板：状态管理独立为纯 ESM 模块 `task-store.mjs`，
可在浏览器与 Node.js 双环境运行；数据通过 `localStorage` 保存在本地，
页面刷新后仍然存在。配套零依赖静态服务器 `server.mjs` 供本地预览。

## 功能清单

- **新增**：输入标题回车或点“添加”
- **编辑**：点“编辑”按钮或双击标题进入行内编辑，回车保存、Esc 取消
- **完成**：勾选复选框切换完成状态（完成项划线置灰）
- **删除**：点“删除”按钮
- **筛选**：全部 / 进行中 / 已完成 三种视图
- **统计**：显示“共 N 项 · 未完成 M 项”
- **清空已完成**：无已完成任务时按钮禁用
- **持久化**：数据写入 localStorage，刷新后恢复
- **响应式**：桌面居中布局，≤600px 移动端单列、无横向滚动、触控目标 ≥44px
- **键盘**：Tab 可达所有控件；Enter 新增；空格/Enter 切换完成；Esc 退出编辑
- **容错**：损坏的本地数据自动降级为空并记录 `lastError`，页面不崩溃

## 快速开始

```bash
# 1. 启动零依赖静态服务器（默认端口 3001，可用 PORT 环境变量覆盖）
node examples/task-board/server.mjs

# 2. 浏览器打开输出地址
#    http://localhost:3001/
```

> 请通过 `http://` 访问（推荐 server.mjs 或任意静态服务器）。
> 直接双击 `index.html` 时，部分浏览器的 `file://` 协议下 `localStorage` 行为不一致。

## 运行测试

状态管理核心使用 Node 内置 `node:test`，无需安装任何依赖：

```bash
# 在 mini-claude-code 根目录下执行
node --test examples/task-board/test/task-store.test.mjs
```

测试全部使用注入的内存 storage 与固定/可控时钟，保证确定性；
覆盖新增、编辑、切换、删除、清空已完成、筛选、统计、
持久化恢复（模拟刷新）、损坏数据降级、storage 异常降级、订阅与 key 隔离等 42 条用例。

## 模块职责

| 文件 | 职责 |
|---|---|
| `task-store.mjs` | 状态管理核心。数据模型、CRUD、统计、订阅、版本化持久化、storage 抽象、id 生成。纯 ESM、零依赖、浏览器/Node 双环境 |
| `test/task-store.test.mjs` | `node:test` 自动化测试，锁定 store 全部公开行为 |
| `app.js` | 浏览器接线层：渲染、事件绑定、行内编辑、键盘操作。业务逻辑全部委托 store |
| `index.html` | 页面骨架，`<script type="module" src="./app.js">` 引入 |
| `style.css` | 全部样式，桌面 + 移动响应式 |
| `server.mjs` | 零依赖静态服务器：`node:http` + `node:fs/promises`，路径穿越防护，MIME 映射，仅服务本目录 |

## 数据模型与存储格式

单条任务：

```js
{
  id: "task_<uuid>",        // crypto.randomUUID()，回退 时间戳+计数器+随机后缀
  title: "写周报",           // 字符串，自动去除首尾空白，非空
  completed: false,          // 布尔
  createdAt: "2026-08-23T00:00:00.000Z",  // ISO 时间字符串
  updatedAt: "2026-08-23T00:00:00.000Z",  // 编辑/切换时更新
}
```

持久化使用版本信封，默认 key 为 `task-board:v1`：

```json
{ "version": 1, "tasks": [ /* Task[] */ ] }
```

加载时逐条清洗：非法 JSON / 版本不符 / tasks 非数组 → 整体降级为空；
缺字段补齐（时间戳用当前时间、completed 非布尔置 false）；标题非法或非对象的条目丢弃。
所有降级都会记录到 `store.lastError`，之后一次成功的写入会将其清零。

## task-store.mjs 公开 API

```js
export const STORAGE_KEY = "task-board:v1";
export function createDefaultStorage();   // 浏览器 localStorage，Node 回退内存 Map
export function createMemoryStorage();    // 闭包 Map，供测试注入
export function createTaskStore({ storage, key, now } = {});
```

store 对象方法：

| 方法 | 说明 |
|---|---|
| `add(title)` | 新增，返回 Task；空/空白标题抛 `TypeError`（code `INVALID_TITLE`） |
| `edit(id, title)` | 改标题，保留完成状态与顺序；空标题抛 `INVALID_TITLE`，不存在抛 `TASK_NOT_FOUND` |
| `toggle(id)` | 切换完成状态；不存在抛 `TASK_NOT_FOUND` |
| `remove(id)` | 删除并返回被删项；不存在抛 `TASK_NOT_FOUND` |
| `clearCompleted()` | 清空已完成，返回删除数量 |
| `filter(view)` | `"all" | "active" | "completed"`，非法值回退 `all`，返回深拷贝 |
| `list()` | 全部任务深拷贝，等价 `filter("all")` |
| `stats()` | `{ total, active, completed }` |
| `subscribe(listener)` | 订阅变更，返回退订函数；每次变更收到最新快照（深拷贝） |
| `lastError`（getter） | 最近一次读写 storage 的错误；正常为 `null` |

## 手动验收清单

1. 新增若干任务（含中文、长文本），刷新页面后数据仍在
2. 编辑任务标题：回车保存、Esc 取消、空标题被拒且原标题保留
3. 勾选/取消完成：行划线置灰、统计“未完成”同步变化
4. 三种筛选各自正确；清空已完成只删已完成项，无已完成时按钮禁用
5. 统计数字与列表一致
6. 删除任务后列表与统计同步
7. 移动端（375px）无横向滚动，触控目标 ≥44px；桌面（≥1024px）居中布局
8. 键盘：Tab 可达输入框/筛选/清空/每项操作；Enter 新增；Esc 退出编辑

## 已知限制与风险

- 浏览器视觉与交互（响应式、键盘焦点样式）需人工验收，当前项目无浏览器自动化工具
- `localStorage` 在 `file://` 下行为因浏览器而异，请用 `server.mjs` 经 `http://` 访问
- 数据保存在当前浏览器与当前源（origin）下；换浏览器或清站点数据会丢失
- 测试已覆盖状态管理全部公开行为；页面接线层为薄层，主要风险集中在视觉与交互细节
