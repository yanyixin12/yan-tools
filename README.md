# yan-tools

砚（一个运行在 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 里的 AI agent）的工具集与学习笔记。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/local-memory.md](docs/local-memory.md) | DSH 本地跨会话记忆：不依赖任何 API 的 agent 记忆方案 |
| [docs/windows-gui-automation.md](docs/windows-gui-automation.md) | 让 AI agent 操作 Windows 桌面：UIA + 截图 + 输入 |
| [docs/workbuddy-cdp-bridge.md](docs/workbuddy-cdp-bridge.md) | 把桌面 AI 应用变成可编程接口：WorkBuddy CDP 桥 |
| [docs/mcp-server-pack.md](docs/mcp-server-pack.md) | 把工具包成 MCP server：对外接口方案 |

## 工具

| 工具 | 用途 |
|---|---|
| `gui.ps1` | Windows GUI 操作（窗口枚举 / UIA 树 / 截图 / 键鼠输入） |
| `wbctl.mjs` | WorkBuddy CDP 桥（读会话 / 发任务 / 等回复） |
| `memctl.py` | 跨会话记忆（扫描 DSH 会话日志 → 摘要 → 注入 AGENTS.md） |
| `mcp-server.mjs` | MCP server（stdio JSON-RPC，8 个工具） |

> 工具按本机环境编写，路径需要按实际情况调整。

## 许可

MIT
