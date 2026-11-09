# DSH 本地跨会话记忆：不依赖任何 API 的 agent 记忆方案

> 本文记录一个可以落地的方案：给 DSH（DeepSeek Harness）里的 agent 加上跨会话记忆，不需要额外 API、不需要向量库、不花钱。适合在本机长期运行的 agent。

## 问题

DSH 的每个会话（session）是独立的。同一个工作区开第二个会话，agent 不知道上一个会话聊过什么、做过什么决定。用户每次都要重复交代背景，agent 也记不住自己的经验。

社区里通常的做法是接一个记忆服务（如 Hindsight），但那需要额外的 API key、服务进程，对个人用户来说成本太高。

## 思路

DSH 有一个关键机制：`~/.dsh/AGENTS.md` 每次会话开头会被读进上下文（agent-instructions）。所以只要把"记忆摘要"写进 AGENTS.md，新会话自然就能看到。

整条链路：

```
sessions/*/session.v4.jsonl.zstd        （原始会话日志，只读）
        │ scan：提取用户消息
        ▼
memory/sessions.json + MEMORY.md        （摘要产物）
        │ inject：写进 AGENTS.md 的标记块
        ▼
~/.dsh/AGENTS.md  <!-- MEMORY:BEGIN --> ... <!-- MEMORY:END -->
        │ 新会话开头自动加载
        ▼
agent 带着记忆开始工作
```

三个环节都可以离线做，零 API 调用。

## 实现

核心脚本 `memctl.py`，纯标准库，三个命令：

- `scan`：遍历 `~/.dsh/sessions/` 下所有 `session-*/session.v4.jsonl.zstd`，解压后逐行解析 JSONL，取 `type == "user/message"` 事件的用户消息文本和时间。
- `inject`：把生成的 MEMORY.md 写进 AGENTS.md 的标记块之间；块外内容一个字节不动；UTF-8 无 BOM。
- `sync`：scan + inject。

关键代码（简化）：

```python
# 解压：Python 3.14+ 有标准库 compression.zstd
from compression import zstd
text = zstd.decompress(path.read_bytes()).decode("utf-8")

# 提取用户消息
for line in text.splitlines():
    event = json.loads(line)
    if event.get("type") != "user/message":
        continue
    content = event["data"]["message"]["content"]
    parts = [p["text"] for p in content if p.get("type") == "text"]
```

注入标记块：

```python
BEGIN = b"<!-- MEMORY:BEGIN -->"
END = b"<!-- MEMORY:END -->"

def inject(agents_md, memory_md):
    data = agents_md.read_bytes()
    block = BEGIN + b"\n" + memory_md + b"\n" + END
    start = data.find(BEGIN)
    end = data.find(END)
    if start >= 0 and end > start:
        data = data[:start] + block + data[end + len(END):]
    else:
        data = data.rstrip(b"\n") + b"\n\n" + block + b"\n"
    agents_md.write_bytes(data)  # 无 BOM
```

## 三个坑

1. **系统消息混入**。DSH 会把运行时上下文、定时提醒、system-reminder、goal_round 自动延续等也记成 `user/message`。不过滤的话，记忆里一半是噪声，AGENTS.md 会被撑到 20KB。要维护一个前缀黑名单（`Current runtime context`、`Time sampled`、`<system-reminder>`、`<hindsight`、`[SCHEDULE REMINDER]`、`<goal_round` 等）。

2. **单字噪声**。用户会发"A"、"1"、"开"这种消息，信息量低，过滤掉（`len(text.strip()) < 2`）。

3. **编码**。Windows PowerShell 5.1 读 UTF-8 无 BOM 的脚本会按 ANSI 解码，中文乱码甚至语法错误。脚本一律 UTF-8 无 BOM，用 Python 执行；写 AGENTS.md 时也绝不能用带 BOM 的编码（DSH 会报 `Unexpected token \ufeff`）。

## 自动更新

用 Windows 计划任务，每天 23:00 跑一次 `sync`，零 token 消耗：

```powershell
schtasks /create /tn "DSH-MemorySync" `
  /tr '"D:\software\python.exe" "C:\Users\<user>\.dsh\im\memory\memctl.py" sync' `
  /sc daily /st 23:00 /f
```

验证任务能跑：`schtasks /run /tn "DSH-MemorySync"`，然后看 MEMORY.md 的修改时间。

## 效果

- 新会话开头带着最近 7 天的用户消息摘要（3–5KB，约 2k token）
- 每天的同步只改 AGENTS.md 一次，之后进入上下文缓存，token 成本很低
- 完全本地，没有 API 依赖，没有隐私外传

## 局限

- 只记"用户说过什么"，不记 agent 的回复和产出（可以扩展）
- 按时间/关键词粗排，没有语义检索（要检索就得上向量库，另说）
- 依赖 `session.v4.jsonl.zstd` 的格式，DSH 升级格式后需要适配
