#!/usr/bin/env python3
# -*- coding: utf-8 -*-
r"""memctl.py -- DSH 本地跨会话记忆（纯标准库，不装第三方包）

用法:
    python memctl.py scan     扫描 sessions -> sessions.json + MEMORY.md
    python memctl.py inject   把 MEMORY.md 注入 AGENTS.md 的标记块
    python memctl.py sync     scan + inject

数据源（只读，绝不修改）:
    C:\Users\13455\.dsh\sessions\<workspace>\session-<uuid>\session.v4.jsonl.zstd

解压优先使用 Python 3.14 标准库 compression.zstd；没有该模块时依次回退到
ctypes 调用系统 libzstd、zstd 命令行（都是标准库或本机工具，不是第三方包）。
异常文件跳过，错误追加到 memory/errors.log。
"""

import ctypes
import ctypes.util
import datetime as dt
import io
import json
import shutil
import subprocess
import sys
from pathlib import Path

try:
    from compression import zstd as _zstd
except ImportError:  # Python < 3.14
    _zstd = None

HOME = Path.home() / ".dsh"
SESSIONS_ROOT = HOME / "sessions"
MEMORY_DIR = HOME / "im" / "memory"
SESSIONS_JSON = MEMORY_DIR / "sessions.json"
MEMORY_MD = MEMORY_DIR / "MEMORY.md"
ERRORS_LOG = MEMORY_DIR / "errors.log"
AGENTS_MD = HOME / "AGENTS.md"

BEGIN = b"<!-- MEMORY:BEGIN -->"
END = b"<!-- MEMORY:END -->"
USER_TYPES = frozenset({"user/message", "user", "message"})
DAYS = 7
MAX_LINES = 200
PREVIEW_CHARS = 120
MIN_CHARS = 2  # 少于 2 个字符的消息（"A"、"1"、"开"）视为噪声，不进记忆
HEADER_LINE = "本文件由 memctl.py 自动生成，汇总最近 7 天的跨会话记忆；请勿手工编辑。"

# DSH 会把系统注入（运行时上下文、定时提醒、技能目录、Hindsight 提示等）也记成
# user/message，这些不是用户真实发言，摘要时必须剔除。
SYSTEM_PREFIXES = (
    "Current runtime context",
    "Time sampled while preparing",
    "<system-reminder>",
    "<hindsight",
    "[SCHEDULE REMINDER]",
    "background job ",
    "The user changed the approval policy",
    "This file changed after it was loaded",
    "The available skill catalog",
    "This repository has a Hindsight memory",
    "A skill is a reusable set",
    "Updated instructions from:",
    "Note: Git Bash not detected",
    "The following workspace instructions",
    "This complete catalog replaces",
    "<goal_round",
)


def is_system_injected(text):
    s = text.lstrip()
    return any(s.startswith(prefix) for prefix in SYSTEM_PREFIXES)


# --------------------------------------------------------------------------
# 错误处理：只追加，不覆盖
# --------------------------------------------------------------------------
def log_error(message):
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    with ERRORS_LOG.open("ab") as fh:
        fh.write(("[%s] %s\n" % (stamp, message)).encode("utf-8"))


# --------------------------------------------------------------------------
# zstd 解压：compression.zstd -> ctypes libzstd -> zstd CLI
# --------------------------------------------------------------------------
class _InBuf(ctypes.Structure):
    _fields_ = [("src", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


class _OutBuf(ctypes.Structure):
    _fields_ = [("dst", ctypes.c_void_p), ("size", ctypes.c_size_t), ("pos", ctypes.c_size_t)]


def _ctypes_decompress(data):
    names = []
    found = ctypes.util.find_library("zstd")
    if found:
        names.append(found)
    names += ["libzstd.dll", "zstd.dll", "libzstd.so.1", "libzstd.dylib", "libzstd.so"]
    lib = None
    for name in names:
        try:
            lib = ctypes.CDLL(name)
            break
        except OSError:
            continue
    if lib is None:
        raise RuntimeError("libzstd not found on this system")

    lib.ZSTD_createDStream.restype = ctypes.c_void_p
    lib.ZSTD_initDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_initDStream.restype = ctypes.c_size_t
    lib.ZSTD_decompressStream.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(_OutBuf), ctypes.POINTER(_InBuf)
    ]
    lib.ZSTD_decompressStream.restype = ctypes.c_size_t
    lib.ZSTD_freeDStream.argtypes = [ctypes.c_void_p]
    lib.ZSTD_freeDStream.restype = ctypes.c_size_t
    lib.ZSTD_isError.argtypes = [ctypes.c_size_t]
    lib.ZSTD_isError.restype = ctypes.c_uint

    stream = lib.ZSTD_createDStream()
    if not stream:
        raise RuntimeError("ZSTD_createDStream failed")
    try:
        lib.ZSTD_initDStream(stream)
        src = ctypes.create_string_buffer(data)
        inp = _InBuf(ctypes.cast(src, ctypes.c_void_p), len(data), 0)
        out = bytearray()
        chunk = 1 << 18
        while True:
            buf = ctypes.create_string_buffer(chunk)
            outb = _OutBuf(ctypes.cast(buf, ctypes.c_void_p), chunk, 0)
            ret = lib.ZSTD_decompressStream(stream, ctypes.byref(outb), ctypes.byref(inp))
            if lib.ZSTD_isError(ret):
                raise RuntimeError("ZSTD_decompressStream reported an error")
            out += buf.raw[:outb.pos]
            if ret == 0:
                if inp.pos < inp.size:
                    continue  # 还有下一帧
                break
            if inp.pos >= inp.size and outb.pos == 0:
                raise RuntimeError("truncated zstd frame")
        return bytes(out)
    finally:
        lib.ZSTD_freeDStream(stream)


def _cli_decompress(path):
    exe = shutil.which("zstd")
    if not exe:
        raise RuntimeError("zstd CLI not found")
    proc = subprocess.run(
        [exe, "-dc", str(path)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False
    )
    if proc.returncode != 0:
        raise RuntimeError("zstd CLI: " + proc.stderr.decode("utf-8", "replace").strip()[:200])
    return proc.stdout


def decompress_zstd(path):
    data = path.read_bytes()
    if _zstd is not None:
        try:
            return _zstd.decompress(data)
        except Exception as first_error:
            try:  # 多帧 / 未知内容大小的流
                with _zstd.ZstdFile(io.BytesIO(data), "rb") as fh:
                    return fh.read()
            except Exception:
                raise first_error
    failures = []
    for attempt in (lambda: _ctypes_decompress(data), lambda: _cli_decompress(path)):
        try:
            return attempt()
        except Exception as exc:
            failures.append("%s: %s" % (type(exc).__name__, exc))
    raise RuntimeError("compression.zstd unavailable; fallbacks failed -> " + " | ".join(failures))


# --------------------------------------------------------------------------
# scan
# --------------------------------------------------------------------------
def content_of(event):
    """兼容 data.message.content（描述）与 data.content（实际数据）两种结构。"""
    data = event.get("data")
    if not isinstance(data, dict):
        return None
    candidates = []
    message = data.get("message")
    if isinstance(message, dict):
        candidates.append(message.get("content"))
    candidates.append(data.get("content"))
    for candidate in candidates:
        if isinstance(candidate, list):
            return candidate
    return None


def time_of(event):
    value = event.get("time")
    if isinstance(value, bool):
        return None
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, str):
        try:
            return int(value)
        except ValueError:
            return None
    return None


def read_session(path, workspace, session_id):
    text = decompress_zstd(path).decode("utf-8")  # 坏文件抛异常 -> 整个文件跳过
    rows = []
    for lineno, line in enumerate(text.splitlines(), 1):
        if not line.strip():
            continue
        try:
            event = json.loads(line)
        except Exception as exc:
            log_error("%s: line %d: bad JSON: %s: %s" % (path, lineno, type(exc).__name__, exc))
            continue
        if not isinstance(event, dict) or event.get("type") not in USER_TYPES:
            continue
        content = content_of(event)
        if content is None:
            continue
        parts = [
            part.get("text")
            for part in content
            if isinstance(part, dict)
            and part.get("type") == "text"
            and isinstance(part.get("text"), str)
        ]
        if not parts:
            continue
        message = "\n".join(parts)
        if not message.strip():
            continue
        if is_system_injected(message):
            continue
        if len(message.strip()) < MIN_CHARS:
            continue
        rows.append({
            "workspace": workspace,
            "session_id": session_id,
            "time": time_of(event),
            "text": message,
        })
    return rows


def workspace_short(name):
    """--C-Users-13455-.dsh-im-- -> im；--D-...-default-workspace-- -> default-workspace"""
    stripped = name.strip("-")
    if not stripped:
        return "?"
    return stripped.rsplit("-", 1)[-1]


def build_memory_md(rows):
    today = dt.datetime.now().date()
    start = today - dt.timedelta(days=DAYS - 1)
    buckets = {}
    for row in rows:
        stamp = row["time"]
        if stamp is None:
            continue
        try:
            when = dt.datetime.fromtimestamp(stamp / 1000.0)  # 本地时间
        except (OverflowError, OSError, ValueError):
            continue
        day = when.date()
        if start <= day <= today:
            buckets.setdefault(day, []).append((when, row))

    lines = [HEADER_LINE, ""]
    days_used = 0
    for day in sorted(buckets, reverse=True):  # 日期倒序
        if len(lines) >= MAX_LINES:
            break
        lines.append("## %s" % day.isoformat())
        days_used += 1
        for when, row in sorted(buckets[day], key=lambda item: item[0], reverse=True):
            if len(lines) >= MAX_LINES:
                break
            preview = " ".join(row["text"][:PREVIEW_CHARS].split())  # 压成单行，前 120 字
            ws = workspace_short(row.get("workspace", ""))
            lines.append("- %s [%s] %s" % (when.strftime("%H:%M"), ws, preview))
        if len(lines) < MAX_LINES:
            lines.append("")
    if days_used == 0:
        lines.append("（最近 7 天没有用户消息）")

    lines = lines[:MAX_LINES]
    markdown = "\n".join(lines).rstrip("\n") + "\n"
    return markdown, days_used, len(markdown.splitlines())


def scan():
    MEMORY_DIR.mkdir(parents=True, exist_ok=True)
    print("[memctl] DSH home: %s" % HOME)
    if not SESSIONS_ROOT.is_dir():
        log_error("sessions root missing: %s" % SESSIONS_ROOT)
        print("[memctl] scan: ERROR sessions root missing: %s" % SESSIONS_ROOT)
        return 1

    files = sorted(SESSIONS_ROOT.rglob("session.v4.jsonl.zstd"))
    print("[memctl] scan: %d session file(s) found" % len(files))
    all_rows = []
    bad_files = 0
    for index, path in enumerate(files, 1):
        rel = path.relative_to(SESSIONS_ROOT)
        workspace = rel.parts[0] if len(rel.parts) > 1 else "(root)"
        session_id = path.parent.name
        if session_id.startswith("session-"):
            session_id = session_id[len("session-"):]
        try:
            rows = read_session(path, workspace, session_id)
        except Exception as exc:
            log_error("%s: skipped file: %s: %s" % (path, type(exc).__name__, exc))
            print("[memctl] scan: [%d/%d] SKIP %s/%s: %s: %s"
                  % (index, len(files), workspace, session_id, type(exc).__name__, exc))
            bad_files += 1
            continue
        all_rows.extend(rows)
        print("[memctl] scan: [%d/%d] %s/%s -> %d message(s)"
              % (index, len(files), workspace, session_id[:8], len(rows)))

    # 按会话分组：先 workspace、再 session_id、最后时间
    all_rows.sort(key=lambda r: (
        r["workspace"], r["session_id"],
        r["time"] if r["time"] is not None else -1,
    ))
    payload = (json.dumps(all_rows, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    SESSIONS_JSON.write_bytes(payload)  # UTF-8 无 BOM
    print("[memctl] scan: %d message(s) from %d session(s) -> %s (%d bytes)"
          % (len(all_rows), len(files) - bad_files, SESSIONS_JSON, len(payload)))

    markdown, days_used, line_count = build_memory_md(all_rows)
    MEMORY_MD.write_bytes(markdown.encode("utf-8"))  # UTF-8 无 BOM
    print("[memctl] scan: %s -> %d day(s), %d line(s), %d bytes"
          % (MEMORY_MD, days_used, line_count, len(markdown.encode("utf-8"))))
    print("[memctl] scan: %d file error(s)%s"
          % (bad_files, (" (see %s)" % ERRORS_LOG) if bad_files else ""))
    return 0


# --------------------------------------------------------------------------
# inject：块外字节一个都不动
# --------------------------------------------------------------------------
def inject():
    if not MEMORY_MD.is_file():
        log_error("inject: %s missing, run scan first" % MEMORY_MD)
        print("[memctl] inject: ERROR %s missing (run scan first)" % MEMORY_MD)
        return 1

    memory = MEMORY_MD.read_bytes()
    original = AGENTS_MD.read_bytes() if AGENTS_MD.is_file() else b""
    newline = b"\r\n" if b"\r\n" in original else b"\n"
    body = memory if memory.endswith(b"\n") else memory + newline
    print("[memctl] inject: MEMORY.md %d bytes (UTF-8, no BOM)" % len(memory))

    begin = original.find(BEGIN)
    end = original.find(END, begin + len(BEGIN)) if begin != -1 else -1
    if begin != -1 and end != -1:
        suffix = original[end + len(END):]
        block = BEGIN + newline + body + END
        if suffix and not suffix.startswith((b"\n", b"\r")):
            block += newline  # 保证 END 独占一行；新增字节仍属于块内
        updated = original[:begin] + block + suffix
        action = "replaced existing memory block"
    else:
        if begin != -1 or end != -1:
            log_error("inject: incomplete MEMORY markers; appending a complete block")
        separator = b"" if (not original or original.endswith(b"\n")) else newline
        updated = original + separator + BEGIN + newline + body + END + newline
        action = "appended memory block at end of file"

    AGENTS_MD.parent.mkdir(parents=True, exist_ok=True)
    AGENTS_MD.write_bytes(updated)  # UTF-8 无 BOM；块外字节原样保留
    print("[memctl] inject: %s" % action)
    print("[memctl] inject: %s %d -> %d bytes (outside block unchanged, UTF-8 no BOM)"
          % (AGENTS_MD, len(original), len(updated)))
    return 0


# --------------------------------------------------------------------------
# CLI
# --------------------------------------------------------------------------
def main(argv):
    command = argv[1] if len(argv) > 1 else ""
    if command not in ("scan", "inject", "sync"):
        print("Usage: python memctl.py scan|inject|sync")
        return 2
    status = 0
    if command in ("scan", "sync"):
        status = scan()
    if status == 0 and command in ("inject", "sync"):
        status = inject()
    if status == 0 and command == "sync":
        print("[memctl] sync: done")
    return status


if __name__ == "__main__":
    sys.exit(main(sys.argv))
