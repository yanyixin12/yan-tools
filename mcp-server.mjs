#!/usr/bin/env node
/**
 * mcp-server.mjs — 砚的工具 MCP server（stdio，零依赖）
 *
 * 把 gui.ps1 和 memctl.py 暴露成 MCP 工具，任何支持 MCP 的客户端都能调用。
 * 协议：JSON-RPC 2.0，stdin/stdout 一行一条消息。
 *
 * 启动：node mcp-server.mjs
 *
 * 注意：GUI 工具需要进程能访问用户桌面（full-access 环境）。
 */
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.env.YAN_HOME || join(homedir(), '.dsh', 'im');
const GUI_PS = join(ROOT, 'gui.ps1');
const MEMCTL = join(ROOT, 'memory', 'memctl.py');
const PYTHON = process.env.PYTHON || 'python';
const SESSIONS_JSON = join(ROOT, 'memory', 'sessions.json');

const PROTOCOL_VERSION = '2026-07-28';

const TOOLS = [
  {
    name: 'gui_windows',
    description: 'List visible top-level windows (title, pid, position, size).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'gui_tree',
    description: 'Dump the UI Automation tree of a window.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title substring' },
        depth: { type: 'integer', description: 'Max depth (default 4)' },
      },
      required: ['window'],
    },
  },
  {
    name: 'gui_shot',
    description: 'Screenshot the full screen or one window (PrintWindow), save PNG.',
    inputSchema: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Window title substring (omit for full screen)' },
        out: { type: 'string', description: 'Output PNG path' },
      },
    },
  },
  {
    name: 'gui_click',
    description: 'Click screen coordinates, or a control by window+name.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        window: { type: 'string' },
        name: { type: 'string' },
      },
    },
  },
  {
    name: 'gui_type',
    description: 'Type Unicode text into the focused control.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
    },
  },
  {
    name: 'gui_key',
    description: 'Send a key or key combination, e.g. CTRL+S, ENTER.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string' } },
      required: ['key'],
    },
  },
  {
    name: 'memory_sync',
    description: 'Scan DSH sessions and refresh the cross-session memory (MEMORY.md + AGENTS.md block).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'memory_search',
    description: 'Search remembered user messages by keyword.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword to search' },
        limit: { type: 'integer', description: 'Max results (default 10)' },
      },
      required: ['query'],
    },
  },
];

function run(cmd, args) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { windowsHide: true });
    let out = '';
    const append = (d) => {
      out += d.toString();
      if (out.length > 200000) out = out.slice(-200000);
    };
    p.stdout.on('data', append);
    p.stderr.on('data', append);
    p.on('error', (e) => resolve({ code: -1, text: 'spawn error: ' + e.message }));
    p.on('close', (code) => resolve({ code, text: out.trim() }));
  });
}

function runPs(script, argv) {
  return run('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...argv]);
}

function runPy(script, argv) {
  return run(PYTHON, [script, ...argv]);
}

async function callTool(name, args) {
  switch (name) {
    case 'gui_windows':
      return runPs(GUI_PS, ['windows']);
    case 'gui_tree': {
      const argv = ['tree', args.window];
      if (args.depth) argv.push('-Depth', String(args.depth));
      return runPs(GUI_PS, argv);
    }
    case 'gui_shot': {
      const argv = ['shot'];
      if (args.window) argv.push('-Window', args.window);
      if (args.out) argv.push('-Out', args.out);
      return runPs(GUI_PS, argv);
    }
    case 'gui_click': {
      const argv = ['click'];
      if (args.x !== undefined && args.y !== undefined) {
        argv.push('-X', String(args.x), '-Y', String(args.y));
      } else if (args.window && args.name) {
        argv.push('-Window', args.window, '-Name', args.name);
      } else {
        return { code: -1, text: 'gui_click: provide x+y or window+name' };
      }
      return runPs(GUI_PS, argv);
    }
    case 'gui_type':
      return runPs(GUI_PS, ['type', args.text]);
    case 'gui_key':
      return runPs(GUI_PS, ['key', args.key]);
    case 'memory_sync':
      return runPy(MEMCTL, ['sync']);
    case 'memory_search': {
      const q = String(args.query || '');
      if (!q) return { code: -1, text: 'memory_search: empty query' };
      const limit = Number(args.limit) || 10;
      try {
        const rows = JSON.parse(readFileSync(SESSIONS_JSON, 'utf8'));
        const hits = rows.filter((r) => typeof r.text === 'string' && r.text.includes(q)).slice(-limit);
        const text = hits.length
          ? hits.map((r) => `${r.workspace} | ${r.text.slice(0, 200)}`).join('\n')
          : 'no match for: ' + q;
        return { code: 0, text };
      } catch (e) {
        return { code: -1, text: 'memory_search failed: ' + e.message };
      }
    }
    default:
      return { code: -1, text: 'unknown tool: ' + name };
  }
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

async function handle(msg) {
  const method = msg.method;
  const id = msg.id;
  if (method === undefined) return; // response from us, ignore

  try {
    if (method === 'initialize') {
      send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: msg.params?.protocolVersion || PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: 'yan-tools', version: '0.1.0' },
        },
      });
      return;
    }
    if (method === 'notifications/initialized' || method === 'initialized') return;
    if (method === 'ping') {
      send({ jsonrpc: '2.0', id, result: {} });
      return;
    }
    if (method === 'tools/list') {
      send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const name = msg.params?.name;
      const args = msg.params?.arguments || {};
      const tool = TOOLS.find((t) => t.name === name);
      if (!tool) throw new Error('unknown tool: ' + name);
      const r = await callTool(name, args);
      send({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text: r.text || '(empty)' }],
          isError: r.code !== 0,
        },
      });
      return;
    }
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32601, message: 'method not found: ' + method } });
    }
  } catch (e) {
    if (id !== undefined) {
      send({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    }
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
let pending = 0;
let queue = Promise.resolve();

rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  pending++;
  queue = queue
    .then(() => handle(msg))
    .catch(() => {})
    .finally(() => {
      pending--;
      if (closed && pending === 0) process.exit(0);
    });
});
rl.on('close', () => {
  closed = true;
  if (pending === 0) process.exit(0);
});
