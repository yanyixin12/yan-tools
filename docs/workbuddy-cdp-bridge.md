# 把桌面 AI 应用变成可编程接口：WorkBuddy CDP 桥

> WorkBuddy（腾讯 CodeBuddy 桌面版）是 Electron 应用。它有官方预留的 CDP 调试开关，可以像操作网页一样操作它：发任务、读回复、触发按钮。本文记录这个桥的搭建过程和坑。

## 为什么要桥

桌面 AI 应用通常只给人用：点输入框、打字、等回复。如果想让别的程序（比如另一个 agent）调用它，常规做法是模拟键鼠——慢、脆、还抢焦点。

Electron 应用有一个更底层的入口：Chrome DevTools Protocol（CDP）。通过 CDP 可以直接操作页面 DOM，不碰鼠标键盘。

## 找到官方开关

翻 `app.asar` 的字符串，能搜到：

```js
let n = process.env.WORKBUDDY_REMOTE_DEBUGGING_PORT;
if (n && /^\d+$/.test(n)) {
  electron.app.commandLine.appendSwitch('remote-debugging-port', n);
  electron.app.commandLine.appendSwitch('remote-allow-origins', ...);
}
```

也就是说，启动前设置环境变量 `WORKBUDDY_REMOTE_DEBUGGING_PORT=9222`，应用就会开 CDP 端口。

**注意**：应用有单实例锁，必须先退出再启动。

```powershell
$env:WORKBUDDY_REMOTE_DEBUGGING_PORT = "9222"
Start-Process "D:\software\WorkBuddy\WorkBuddy.exe"
```

## 连接

```javascript
const targets = await fetch('http://127.0.0.1:9222/json').then(r => r.json());
const page = targets.find(t => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
```

之后就是标准的 CDP：

- `Runtime.evaluate`：在页面里执行 JS，读写 DOM
- `Input.insertText`：往聚焦的输入框插入文本（比 JS 赋值可靠）

## 操作界面

WorkBuddy 的界面结构（用 `document.querySelector` 实测）：

| 元素 | 选择器 |
|---|---|
| 输入框 | `div[contenteditable="true"][role="textbox"]` |
| 发送按钮 | `button[aria-label="发送"]` |
| 用户消息 | `.cr-self-message` |
| AI 回复 | `.cr-agent`（带 `data-message-id`） |
| 完成标志 | `.conversation-finished-footer` |

发一条消息的流程：

1. 清空输入框（全选 + `execCommand('delete')`）
2. `Input.insertText` 写入任务文本
3. 等发送按钮从 `disabled` 变成可用
4. 点击发送
5. 轮询 `.cr-agent` 数量增加，等回复文本稳定或完成标志出现

## 三个坑

1. **Slate 编辑器状态不同步**。用 `execCommand('insertText')` 写进去的文字，DOM 里有、但 React 状态没更新，发送按钮不亮。必须用 CDP 的 `Input.insertText`（走真实的 beforeinput 事件）。

2. **等待逻辑要区分占位消息**。回复生成前会先出现一个 `cr-synthetic-pending-assistant` 占位（"正在生成…"），它不是最终回复。判断完成要看：消息 id 不以 `cr-synthetic` 开头、footer 在最后一条消息之后、文本连续稳定 6 秒。

3. **单实例锁**。应用在运行时启动新实例会被转发后退出。要开 CDP 必须完整退出旧实例。

## 边界

- 这本质是"操作界面"，依赖 DOM 结构；应用更新后选择器可能变。
- 体验版有额度限制，不适合高频调用。
- 实测：让它做 GUI 任务（操作别的软件）很慢、容易出错；做代码/文本任务才是它的长项。

## 结论

对于 Electron 桌面应用，CDP 是最干净的自动化入口。比模拟键鼠稳、比 UIA 省、不抢焦点。前提是应用恰好留了调试开关——WorkBuddy 留了。
