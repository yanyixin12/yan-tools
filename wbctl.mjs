#!/usr/bin/env node
/**
 * wbctl.mjs — WorkBuddy CDP 桥
 *
 * 通过 CDP 远程调试端口操作 WorkBuddy 桌面端：读会话、发任务、等回复。
 * 全程 DOM 级操作，不截图、不模拟键鼠、不抢焦点。
 *
 * 前置条件：WorkBuddy 必须以 CDP 模式启动（见 start-wb.cmd），
 * 默认端口 127.0.0.1:9222。
 *
 * 用法：
 *   node wbctl.mjs status
 *   node wbctl.mjs read [--count 5] [--max 2000]
 *   node wbctl.mjs send "任务描述"
 *   node wbctl.mjs wait [--timeout 180] [--max 6000]
 *   node wbctl.mjs ask "任务描述" [--timeout 180] [--max 6000]
 *
 * 说明：
 *   - send/ask 会真的发到 WorkBuddy 当前打开的会话。需要新会话请先在界面上点"新建任务"。
 *   - wait 在 Node 本地轮询 DOM，不消耗模型 token；只有最终结果回传。
 *   - 所有命令输出 JSON（status 输出一行文本）。
 */

const PORT = process.env.WB_CDP_PORT || '9222';
const ORIGIN = `http://127.0.0.1:${PORT}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--count' || a === '--timeout' || a === '--max') out[a.slice(2)] = Number(argv[++i]);
    else out._.push(a);
  }
  return out;
}

async function findTarget() {
  let res;
  try {
    res = await fetch(`${ORIGIN}/json`, { signal: AbortSignal.timeout(4000) });
  } catch (e) {
    throw new Error(
      `连不上 WorkBuddy CDP（${ORIGIN}）。WorkBuddy 没开，或没以 CDP 模式启动。用 start-wb.cmd 启动。`
    );
  }
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  const targets = await res.json();
  const page =
    targets.find((t) => t.type === 'page' && /WorkBuddy/i.test(t.title || '')) ||
    targets.find((t) => t.type === 'page');
  if (!page) throw new Error('CDP 里没有 page target（WorkBuddy 窗口没加载？）');
  return page;
}

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
      }
    };
  }

  static async connect() {
    const target = await findTarget();
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('WebSocket 连接失败'));
      setTimeout(() => reject(new Error('WebSocket 连接超时')), 5000);
    });
    return { cdp: new Cdp(ws), target };
  }

  call(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const r = await this.call('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'exception';
      throw new Error(String(d).slice(0, 500));
    }
    if (r.result?.subtype === 'error') throw new Error(String(r.result.description || 'error').slice(0, 500));
    return r.result?.value;
  }

  close() {
    try { this.ws.close(); } catch {}
  }
}

// ---------- DOM helpers（注入到页面里执行的表达式） ----------

const EXPR = {
  title: `document.title`,
  inputText: `(() => { const el = document.querySelector('div[contenteditable="true"][role="textbox"]'); return el ? (el.innerText || '').trim() : null; })()`,
  clearInput: `(() => {
    const el = document.querySelector('div[contenteditable="true"][role="textbox"]');
    if (!el) return 'no-input';
    el.focus();
    const sel = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(el);
    sel.removeAllRanges();
    sel.addRange(range);
    document.execCommand('delete');
    return 'cleared';
  })()`,
  readMessages: (count) => `
    (() => {
      const nodes = [...document.querySelectorAll('.cr-self-message, .cr-agent')];
      return JSON.stringify(nodes.slice(-${count}).map(e => ({
        role: e.classList.contains('cr-self-message') ? 'user' : 'agent',
        id: e.getAttribute('data-message-id') || e.getAttribute('data-user-message-id') || '',
        text: (e.innerText || '').trim()
      })));
    })()`,
  agentCount: `document.querySelectorAll('.cr-agent').length`,
  inputExists: `!!document.querySelector('div[contenteditable="true"][role="textbox"]')`,
  insertText: (text) => `
    (() => {
      const el = document.querySelector('div[contenteditable="true"][role="textbox"]');
      if (!el) return 'no-input';
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (document.execCommand('delete') === false) return 'delete-failed';
      const ok = document.execCommand('insertText', false, ${JSON.stringify(text)});
      return ok ? 'inserted' : 'insert-failed';
    })()`,
  sendButtonEnabled: `(() => { const b = document.querySelector('button[aria-label="发送"]'); return !!(b && !b.disabled); })()`,
  clickSend: `(() => { const b = document.querySelector('button[aria-label="发送"]'); if (!b || b.disabled) return false; b.click(); return true; })()`,
  userCount: `document.querySelectorAll('.cr-self-message').length`,
  lastAgent: `(() => {
    const agents = [...document.querySelectorAll('.cr-agent')];
    const last = agents[agents.length - 1];
    const footers = [...document.querySelectorAll('.conversation-finished-footer')];
    const lastFooter = footers[footers.length - 1];
    const lastId = last ? (last.getAttribute('data-message-id') || '') : '';
    // footer 必须位于最后一条 agent 消息之后，才算这条回复完成
    const hasFooter = !!(last && lastFooter && (last.compareDocumentPosition(lastFooter) & Node.DOCUMENT_POSITION_FOLLOWING));
    return JSON.stringify({
      count: agents.length,
      id: lastId,
      text: last ? (last.innerText || '').trim() : '',
      hasFooter,
      pending: /^cr-synthetic/i.test(lastId),
      generating: !!document.querySelector('[class*="typing"], [class*="generating"], [class*="streaming"]')
    });
  })()`,
};

function clip(text, max) {
  if (!max || text.length <= max) return text;
  return text.slice(0, max) + `\n…[截断，原文 ${text.length} 字符]`;
}

// ---------- 命令 ----------

async function cmdStatus() {
  const { cdp, target } = await Cdp.connect();
  try {
    const title = await cdp.eval(EXPR.title);
    const input = await cdp.eval(EXPR.inputExists);
    console.log(`OK WorkBuddy CDP @ ${ORIGIN} | target="${title}" | 输入框${input ? '就绪' : '缺失'} | url=${target.url.slice(0, 120)}`);
  } finally {
    cdp.close();
  }
}

async function cmdRead(args) {
  const count = args.count || 5;
  const max = args.max || 2000;
  const { cdp } = await Cdp.connect();
  try {
    const raw = await cdp.eval(EXPR.readMessages(count));
    const msgs = JSON.parse(raw).map((m) => ({ ...m, text: clip(m.text, max) }));
    console.log(JSON.stringify({ messages: msgs }, null, 2));
  } finally {
    cdp.close();
  }
}

async function doSend(cdp, text) {
  const cleared = await cdp.eval(EXPR.clearInput);
  if (cleared !== 'cleared') throw new Error(`清空输入框失败: ${cleared}`);

  // 用 CDP 真实输入事件（Slate 走 beforeinput，能同步 React 状态）
  await cdp.call('Input.insertText', { text });

  let enabled = false;
  for (let i = 0; i < 30; i++) {
    enabled = await cdp.eval(EXPR.sendButtonEnabled);
    if (enabled) break;
    await sleep(150);
  }

  if (!enabled) {
    // 回退：逐字符派发键盘事件
    await cdp.eval(EXPR.clearInput);
    for (const ch of text) {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch });
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
    }
    for (let i = 0; i < 30; i++) {
      enabled = await cdp.eval(EXPR.sendButtonEnabled);
      if (enabled) break;
      await sleep(150);
    }
  }

  if (!enabled) {
    const cur = await cdp.eval(EXPR.inputText);
    throw new Error(`发送按钮一直不可用（输入框当前内容: ${JSON.stringify(cur)}）`);
  }

  const beforeUser = await cdp.eval(EXPR.userCount);
  const clicked = await cdp.eval(EXPR.clickSend);
  if (!clicked) throw new Error('点击发送失败');

  // 确认消息已进入会话
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    const now = await cdp.eval(EXPR.userCount);
    if (now > beforeUser) return;
  }
  throw new Error('发送后会话里没有出现新的用户消息（可能被拦截）');
}

async function waitReply(cdp, timeoutSec, beforeCount) {
  const start = Date.now();
  let lastText = '';
  let stable = 0;
  while (Date.now() - start < timeoutSec * 1000) {
    const state = JSON.parse(await cdp.eval(EXPR.lastAgent));
    const isNew = beforeCount == null || state.count > beforeCount;
    if (isNew && !state.pending) {
      if (state.hasFooter) return state; // 完成标志出现
      if (state.text === lastText) {
        stable++;
        if (stable >= 3) return state; // 文本稳定 6 秒
      } else {
        lastText = state.text;
        stable = 0;
      }
    }
    await sleep(2000);
  }
  const state = JSON.parse(await cdp.eval(EXPR.lastAgent));
  return { ...state, timeout: true };
}

async function cmdSend(args) {
  const text = args._[1];
  if (!text) throw new Error('用法: node wbctl.mjs send "任务描述"');
  const { cdp } = await Cdp.connect();
  try {
    await doSend(cdp, text);
    console.log(JSON.stringify({ ok: true, sent: text }, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdWait(args) {
  const timeout = args.timeout || 180;
  const max = args.max || 6000;
  const { cdp } = await Cdp.connect();
  try {
    const r = await waitReply(cdp, timeout);
    console.log(JSON.stringify({ ok: true, timeout: !!r.timeout, messages: [{ role: 'agent', id: r.id, text: clip(r.text, max) }] }, null, 2));
  } finally {
    cdp.close();
  }
}

async function cmdAsk(args) {
  const text = args._[1];
  if (!text) throw new Error('用法: node wbctl.mjs ask "任务描述"');
  const timeout = args.timeout || 180;
  const max = args.max || 6000;
  const { cdp } = await Cdp.connect();
  try {
    const beforeCount = JSON.parse(await cdp.eval(EXPR.lastAgent)).count;
    await doSend(cdp, text);
    const r = await waitReply(cdp, timeout, beforeCount);
    console.log(JSON.stringify({ ok: true, timeout: !!r.timeout, sent: text, messages: [{ role: 'agent', id: r.id, text: clip(r.text, max) }] }, null, 2));
  } finally {
    cdp.close();
  }
}

// ---------- main ----------

const args = parseArgs(process.argv.slice(2));
const cmd = args._[0];

const commands = {
  status: cmdStatus,
  read: cmdRead,
  send: cmdSend,
  wait: cmdWait,
  ask: cmdAsk,
};

(async () => {
  if (!cmd || !commands[cmd]) {
    console.error('用法: node wbctl.mjs <status|read|send|wait|ask> [参数]');
    console.error('  status                    检查连接');
    console.error('  read [--count N] [--max N] 读最近 N 条消息');
    console.error('  send "文本"               发任务到当前会话');
    console.error('  wait [--timeout S]        等当前会话出新回复');
    console.error('  ask "文本" [--timeout S]  发任务并等回复');
    process.exit(2);
  }
  try {
    await commands[cmd](args);
    process.exit(0);
  } catch (e) {
    console.error(JSON.stringify({ ok: false, error: e.message }, null, 2));
    process.exit(1);
  }
})();
