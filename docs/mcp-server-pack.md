# 把工具包成 MCP server：gui.ps1 / memctl.py 的对外接口方案

> 目标：让 `gui.ps1`（Windows GUI 操作）和 `memctl.py`（跨会话记忆）能被任何支持 MCP 的 AI 应用调用，而不只是 DSH。这既是能力复用，也是"可展示产出"。

## 为什么选 MCP

MCP（Model Context Protocol）是 AI 应用与外部工具之间的标准协议。DSH 已经通过 `mcp-resources` 支持接入 MCP server。把工具包成 MCP server 之后：

- DSH 可以调用
- 其他 AI 客户端（Claude Desktop、Codex 等）也可以调用
- 工具实现与调用方解耦

## 整体架构

```
AI 客户端（Host）
   │  stdio（JSON-RPC，一行一条消息）
   ▼
mcp-server.mjs
   ├─ tools/list  → 描述可调用的工具
   └─ tools/call  → 执行：spawn PowerShell 调 gui.ps1，或 spawn python 调 memctl.py
```

## 协议最小实现

MCP 的 stdio 传输：每行一个 JSON-RPC 2.0 消息。服务器只需要实现三个方法：

### 1. initialize

客户端发：

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2026-07-28","capabilities":{},"clientInfo":{"name":"dsh","version":"0.2.2"}}}
```

服务器回（简化）：

```json
{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2026-07-28","capabilities":{"tools":{}},"serverInfo":{"name":"yan-tools","version":"0.1.0"}}}
```

### 2. tools/list

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

回工具清单：

```json
{"jsonrpc":"2.0","id":2,"result":{"tools":[
  {"name":"gui_windows","description":"列出可见窗口","inputSchema":{"type":"object","properties":{}}},
  {"name":"gui_shot","description":"截取窗口或全屏","inputSchema":{"type":"object","properties":{"window":{"type":"string"},"out":{"type":"string"}}}},
  {"name":"gui_click","description":"点击坐标或控件","inputSchema":{"type":"object","properties":{"x":{"type":"integer"},"y":{"type":"integer"},"window":{"type":"string"},"name":{"type":"string"}}}},
  {"name":"gui_type","description":"输入 Unicode 文本","inputSchema":{"type":"object","properties":{"text":{"type":"string"}},"required":["text"]}},
  {"name":"memory_sync","description":"扫描会话并更新记忆","inputSchema":{"type":"object","properties":{}}},
  {"name":"memory_search","description":"按关键词搜索记忆","inputSchema":{"type":"object","properties":{"query":{"type":"string"}},"required":["query"]}}
]}}
```

### 3. tools/call

```json
{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"gui_windows","arguments":{}}}
```

回：

```json
{"jsonrpc":"2.0","id":3,"result":{"content":[{"type":"text","text":"[1] WorkBuddy | pid=21604 | ..."}]}}
```

执行逻辑：

```javascript
import { spawn } from 'node:child_process';

function runPs(script, args) {
  return new Promise((resolve) => {
    const p = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], { windowsHide: true });
    let out = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => out += d);
    p.on('close', code => resolve({ code, text: out.slice(0, 20000) }));
  });
}
```

## 关键设计决策

### 1. 工具粒度

- `gui_*`：把 gui.ps1 的六个命令直接映射成六个工具，参数透传。**不做"高层动作"封装**（比如"打开某个软件"），保持工具原子化，让模型自己编排。
- `memory_*`：先做 `memory_sync`（跑 memctl.py sync）和 `memory_search`（grep sessions.json）。检索先用关键词，不上向量库。

### 2. 安全边界

- GUI 工具只在本机运行，需要进程能访问用户桌面（在 DSH 沙箱内跑会失败，要用 full-access 模式）。
- `memory_search` 只读 `memories/sessions.json`，不碰 AGENTS.md。
- 所有工具都不接受任意命令执行（没有 `run_command` 这种万能入口）。

### 3. 部署

- 单文件 `mcp-server.mjs`，Node 24 直接跑，零依赖。
- 在 DSH 的 `mcp-resources` 配置里加一条 server 定义（stdio 启动）。
- 接入后验证：`tools/list` 能列出工具、`tools/call` 能执行、失败有明确错误。

## 验证清单

- [ ] `initialize` 返回正常
- [ ] `tools/list` 列出 6 个工具
- [ ] `gui_windows` 返回窗口列表
- [ ] `gui_shot` 生成 PNG 且能看
- [ ] `memory_sync` 更新 MEMORY.md
- [ ] `memory_search` 返回匹配的会话片段
- [ ] 错误路径：不存在的窗口/参数缺失，返回结构化错误

## 风险

- MCP 版本差异：不同客户端要求的 protocolVersion 不同，要宽松处理。
- 工具调用阻塞：GUI 操作可能慢，要设超时（默认 30 秒）。
- 权限：GUI 操作在沙箱内不可用，文档里要说清楚。
