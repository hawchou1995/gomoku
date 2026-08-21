'use strict';
/**
 * gomoku-forbid-endgame.test.js — 黑棋禁手判负终局（GOKUP-003）验证
 *
 * 用户已拍板 RIF 规则：黑棋落禁手点 → 黑负、白胜，对局立即结束（不再"重走"）。
 *
 * 验证分两层：
 *  A. Engine 层（纯逻辑，无 DOM）：前 22 手 + 黑(5,4) → play() 返回
 *     {ok:false, reason:'forbid', forbid:'三三'}，且引擎不落子、局面停在 22 手。
 *  B. App 层（DOM stub 驱动 js/app.js 全量加载）：
 *     本地双人（pvp）模式 + 开启禁手 → 黑方落 22 手后落 (5,4) →
 *     断言对局立即终局、白胜：
 *       - result modal 文案"白方 胜 / 黑方禁手（三三）判负"
 *       - 状态条 game-status = "黑方禁手判负"
 *       - 历史记录 result='white'、moves 停在 22（黑子未落）
 *       - 终局后棋盘点击提示"对局已结束"
 *     另做源码级静态断言：联机 forbid 终局分支（case 'forbid' / host 广播）已就位，
 *     net.js 无需改动（broadcast 通用）。
 *
 * 运行：node tests/gomoku-forbid-endgame.test.js [replay.json]
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js/engine.js'));
const REPLAY = process.argv[2] || 'C:/Users/XAUTHUB/Downloads/gomoku-game-2026-08-21T17-05-12-832Z.json';

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ─────────────────────────── A. Engine 层 ───────────────────────────
section('A. Engine 层：前 22 手 + 黑(5,4) 判禁');
(function () {
  const data = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
  const g = new E.Game();
  g.forbidEnabled = true;
  for (const m of data.moves.slice(0, 22)) {
    const r = g.play(m.x, m.y);
    if (!r.ok) throw new Error('前 22 手不合法 ' + JSON.stringify(m));
  }
  assert(g.turn === E.BLACK, '22 手后轮到黑方');
  const pr = g.play(5, 4);
  assert(pr.ok === false && pr.reason === 'forbid' && pr.forbid === '三三',
    'play(5,4) → {ok:false, reason:forbid, forbid:三三}（实测 ' + JSON.stringify(pr) + '）');
  assert(E.get(g.board, 5, 4) === E.EMPTY, '引擎不落禁手子（(5,4) 仍为空）');
  assert(g.moves.length === 22 && g.over === null,
    '引擎层面局面未推进（moves=22, over=null）——按 RIF 终局判负由 App 层完成');
})();

// ─────────────────────────── DOM stub ───────────────────────────

function makeClassList() {
  const set = new Set();
  return {
    add() { Array.prototype.forEach.call(arguments, function (c) { set.add(c); }); },
    remove() { Array.prototype.forEach.call(arguments, function (c) { set.delete(c); }); },
    toggle(c, force) {
      const on = force === undefined ? !set.has(c) : !!force;
      if (on) set.add(c); else set.delete(c);
      return on;
    },
    contains(c) { return set.has(c); }
  };
}

function makeEl(id) {
  const el = {
    id: id || '',
    textContent: '',
    innerHTML: '',
    className: '',
    style: {},
    disabled: false,
    checked: false,
    value: '',
    dataset: {},
    clientWidth: 800,
    clientHeight: 800,
    parentElement: null,
    classList: makeClassList(),
    _listeners: {},
    _children: []
  };
  el.addEventListener = function (type, fn) { (el._listeners[type] = el._listeners[type] || []).push(fn); };
  el.removeEventListener = function (type, fn) {
    const a = el._listeners[type];
    if (a) { const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  };
  el.dispatchEvent = function (ev) { (el._listeners[ev.type] || []).forEach(function (fn) { fn.call(el, ev); }); };
  el.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: el.clientWidth, bottom: el.clientHeight, width: el.clientWidth, height: el.clientHeight };
  };
  el.hasAttribute = function () { return false; };
  el.getAttribute = function (k) { return el.dataset[k] != null ? el.dataset[k] : null; };
  el.setAttribute = function (k, v) { el.dataset[k] = v; };
  el.closest = function () { return null; };
  el.querySelector = function () { return null; };
  el.querySelectorAll = function () { return []; };
  el.focus = function () {};
  return el;
}

const els = new Map();
const board = makeEl('board');
board.getContext = function () {
  if (!board._ctx) {
    board._ctx = new Proxy({}, {
      get: function (t, k) {
        if (k === 'measureText') return function () { return { width: 10 }; };
        if (k === 'createLinearGradient' || k === 'createRadialGradient') return function () { return { addColorStop: function () {} }; };
        return function () {};
      },
      set: function () { return true; }
    });
  }
  return board._ctx;
};
els.set('board', board);

function getEl(id) {
  if (!els.has(id)) els.set(id, makeEl(id));
  return els.get(id);
}

const bodyEl = makeEl('body');
bodyEl.classList = makeClassList();
const documentStub = {
  body: bodyEl,
  documentElement: makeEl('html'),
  getElementById: getEl,
  querySelector: function (sel) {
    if (sel === '.board-scroll' || sel === '.board-wrap') { const e = makeEl('qs-' + sel); e.clientWidth = 800; e.clientHeight = 800; return e; }
    if (sel === '.ai-setup .level-btn[data-level="4"]') { const e = makeEl('lv4'); e.dataset.level = '4'; return e; }
    return makeEl('qs');
  },
  querySelectorAll: function (sel) {
    if (sel === '.ai-setup .level-btn') {
      const arr = [];
      for (let i = 1; i <= 9; i++) { const e = makeEl('lv' + i); e.dataset.level = String(i); arr.push(e); }
      arr.forEach = Array.prototype.forEach;
      return arr;
    }
    return [];
  },
  addEventListener: function () {},
  removeEventListener: function () {},
  createElement: function (tag) { return makeEl('ce-' + tag); }
};

// 观测点
const savedHistory = [];
const audioCalls = [];

const sandbox = {
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  setInterval: setInterval,
  clearInterval: clearInterval,
  Math: Math,
  Date: Date,
  performance: { now: function () { return Date.now(); } },
  JSON: JSON,
  Promise: Promise,
  Proxy: Proxy,
  Set: Set,
  Map: Map,
  Uint8Array: Uint8Array,
  navigator: { vibrate: function () {}, clipboard: { writeText: function () {} } },
  localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  sessionStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
  document: documentStub,
  getComputedStyle: function () {
    return { paddingTop: '0px', paddingBottom: '0px', paddingLeft: '0px', paddingRight: '0px',
             getPropertyValue: function () { return 'system-ui'; } };
  },
  addEventListener: function () {},
  Blob: function () {},
  URL: { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} }
};
sandbox.window = sandbox;
sandbox.window.GomokuEngine = E;
sandbox.window.GomokuAI = {};
sandbox.window.GomokuNet = function () {};
sandbox.window.GomokuAudio = {
  place: function () { audioCalls.push('place'); },
  win: function () { audioCalls.push('win'); },
  lose: function () { audioCalls.push('lose'); },
  chat: function () {}, undo: function () {}, unlock: function () {}
};
sandbox.window.GomokuStorage = {
  loadAll: function () { return []; },
  add: function (rec) { savedHistory.unshift(rec); return rec; },
  remove: function () {}, clear: function () {}, get: function () { return null; }
};
sandbox.window.Peer = undefined;
sandbox.window.devicePixelRatio = 1;
sandbox.window.matchMedia = function () { return { matches: false }; };
sandbox.window.requestAnimationFrame = function (cb) { setTimeout(cb, 0); };

vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'), sandbox, { filename: 'app.js' });

// 事件驱动 helper
function fire(id, type, opts) {
  const el = getEl(id);
  const ev = opts || {};
  ev.type = type;
  ev.target = el;
  el.dispatchEvent(ev);
  return el;
}
function clickBoard(x, y) {
  const c = 100;
  board.clientWidth = (E.SIZE + 1) * c;
  board.clientHeight = board.clientWidth;
  const ev = { type: 'click', clientX: (x + 1) * c, clientY: (y + 1) * c, target: board };
  board.dispatchEvent(ev);
}
const tick = function (ms) { return new Promise(function (r) { setImmediate(r); }); };

// ─────────────────────────── B. App 层：pvp 禁手判负 ───────────────────────────
section('B. App 层（DOM stub）：本地双人 + 禁手开启，黑(5,4) → 白胜终局');
(async function () {
  // 1. 进入本地双人对局界面
  fire('btn-enter-pvp', 'click');
  assert(getEl('game-status').textContent.indexOf('等待开局') >= 0, '进入 pvp 后状态条为「等待开局…」（实测 "' + getEl('game-status').textContent + '"）');

  // 2. 开启黑棋禁手
  const tf = getEl('toggle-forbid');
  tf.checked = true;
  fire('toggle-forbid', 'change');
  assert(getEl('toast').textContent.indexOf('禁手') >= 0, '开启禁手开关有提示（实测 "' + getEl('toast').textContent + '"）');

  // 3. 开始对局
  fire('btn-start-ai', 'click');
  assert(getEl('toast').textContent.indexOf('本地双人') >= 0, '点开始对局后提示本地双人开局（实测 "' + getEl('toast').textContent + '"）');

  // 4. 落前 22 手（对局 JSON 前 22 手，禁手开启全部合法）
  const data = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
  for (const m of data.moves.slice(0, 22)) {
    clickBoard(m.x, m.y);
    await tick();
  }
  await tick();
  assert(getEl('game-status').textContent.indexOf('黑方') >= 0, '22 手后轮到黑方落子（实测 "' + getEl('game-status').textContent + '"）');

  // 5. 黑方落禁手点 (5,4) → 按 RIF 判负终局（白胜）
  clickBoard(5, 4);
  await tick();

  const modalHtml = getEl('modal-card').innerHTML;
  const status = getEl('game-status').textContent;
  const hudStatus = getEl('hud-status').textContent;
  assert(modalHtml.indexOf('白方 胜') >= 0, 'result modal 主文案"白方 胜"（实测片段: ' + modalHtml.replace(/<[^>]+>/g, ' ').slice(0, 60) + '）');
  assert(modalHtml.indexOf('黑方禁手（三三）判负') >= 0, 'result modal 子文案"黑方禁手（三三）判负"，禁手类型未被吞掉');
  assert(status === '黑方禁手判负', '状态条 = "黑方禁手判负"（实测 "' + status + '"）');
  assert(hudStatus === '黑方禁手判负', 'HUD 状态 = "黑方禁手判负"（实测 "' + hudStatus + '"）');
  assert(!getEl('modal-root').classList.contains('hidden'), '终局弹窗已弹出（modal-root 可见）');

  // 历史记录：winner=white、黑子未落（moves=22）
  assert(savedHistory.length === 1, 'saveHistory 已落库 1 条记录');
  if (savedHistory.length >= 1) {
    const rec = savedHistory[0];
    assert(rec.result === 'white', '导出记录 result="white"（实测 "' + rec.result + '"）');
    assert(rec.moves.length === 22, '记录 moves=22（黑子未落在 (5,4)，实测 ' + rec.moves.length + '）');
    assert(rec.winnerName === '白方', '记录 winnerName=白方（实测 "' + rec.winnerName + '"）');
    assert(rec.moves[21].x === 5 && rec.moves[21].y === 3, '最后落子仍为第 22 手 (5,3)（白方），未被禁手黑子顶替');
  }
  // 玩家执黑（黑负）→ 输音效
  assert(audioCalls.indexOf('lose') >= 0 && audioCalls.indexOf('win') < 0, '玩家执黑判负 → 触发 lose 音效（非 win）');

  // 6. 终局后棋盘点击 → 明确提示重开（证明 over 已置位，流程与普通终局一致）
  clickBoard(1, 1);
  await tick();
  assert(getEl('toast').textContent.indexOf('对局已结束') >= 0, '终局后落子提示「对局已结束」（实测 "' + getEl('toast').textContent + '"）');

  // 7. 「再来一局」按钮存在（复用普通终局渲染路径）
  assert(modalHtml.indexOf('再来一局') >= 0, '终局 modal 含「再来一局」（走既有 endGame 渲染路径）');
})();

// ─────────────────────────── C. 联机静态断言 ───────────────────────────
section('C. 联机禁手终局分支（源码静态检查）');
(async function () {
  const src = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  assert(src.indexOf("case 'forbid':") >= 0, "app.js 含联机消息 case 'forbid'（双端/观战渲染禁手终局）");
  assert(src.indexOf("handleNetMessage({ type: 'forbid', forbid: r.forbid }") >= 0, 'host 权威：move 判禁 → 广播 forbid 终局');
  assert(src.indexOf("state.net.broadcast('forbid'") >= 0, 'host 广播 forbid 终局消息');
  assert(src.indexOf("reason: 'forbid', forbid: forbid") >= 0, '本地 finishByForbid 保留 forbid 类型');
  assert(src.indexOf("state.game.over.reason = snap.over.reason") >= 0, 'applySnapshot 补回 reason/forbid（重连渲染一致）');
  const netSrc = fs.readFileSync(path.join(ROOT, 'js/net.js'), 'utf8');
  assert(netSrc.indexOf('broadcast') >= 0, 'net.js broadcast 为通用协议，无需改动（forbid 走同一通道）');
})();

// ─────────────────────────── D. 联机 forbid 终局渲染冒烟 ───────────────────────────
// 独立 DOM sandbox + FakeNet：host 建房 → 收到 forbid 终局消息 → 双端同构渲染（host 额外落库+广播）
section('D. 联机 forbid 终局消息渲染（host 视角冒烟）');
(async function () {
  const els2 = new Map();
  const board2 = makeEl('board');
  board2.getContext = function () {
    if (!board2._ctx) {
      board2._ctx = new Proxy({}, {
        get: function (t, k) {
          if (k === 'measureText') return function () { return { width: 10 }; };
          if (k === 'createLinearGradient' || k === 'createRadialGradient') return function () { return { addColorStop: function () {} }; };
          return function () {};
        },
        set: function () { return true; }
      });
    }
    return board2._ctx;
  };
  els2.set('board', board2);
  const getEl2 = function (id) { if (!els2.has(id)) els2.set(id, makeEl(id)); return els2.get(id); };
  const body2 = makeEl('body'); body2.classList = makeClassList();
  const doc2 = {
    body: body2, documentElement: makeEl('html'),
    getElementById: getEl2,
    querySelector: function (sel) {
      if (sel === '.board-scroll' || sel === '.board-wrap') { const e = makeEl('qs-' + sel); e.clientWidth = 800; e.clientHeight = 800; return e; }
      if (sel === '.ai-setup .level-btn[data-level="4"]') { const e = makeEl('lv4'); e.dataset.level = '4'; return e; }
      return makeEl('qs');
    },
    querySelectorAll: function (sel) {
      if (sel === '.ai-setup .level-btn') { const arr = []; for (let i = 1; i <= 9; i++) { const e = makeEl('lv' + i); e.dataset.level = String(i); arr.push(e); } arr.forEach = Array.prototype.forEach; return arr; }
      return [];
    },
    addEventListener: function () {}, removeEventListener: function () {},
    createElement: function (tag) { return makeEl('ce-' + tag); }
  };

  const saved2 = [];
  const audio2 = [];
  const netBroadcasts = [];
  function FakeNet(cb) {
    this.cb = cb;
    this.isHost = true;
    this.mySeat = 'black';
    this.mySid = 'h1';
    this._closed = false;
    const self = this;
    this.fire = function (msg) { if (this.cb.onMessage) this.cb.onMessage(msg, 'black'); }; // 模拟收到联机消息
    sandbox2.window.__net = this; // 暴露给测试驱动
  }
  FakeNet.genRoomCode = function () { return 'TEST'; };
  FakeNet.prototype.send = function (type, payload) {
    const msg = payload || {}; msg.type = type; msg.seat = this.mySeat;
    if (this.cb.onMessage) this.cb.onMessage(msg, this.mySeat);
  };
  FakeNet.prototype.broadcast = function (type, payload) {
    const msg = payload || {}; msg.type = type; msg.seat = this.mySeat;
    netBroadcasts.push(msg);
  };
  FakeNet.prototype.sendTo = function () {};
  FakeNet.prototype.createRoom = function () {};
  FakeNet.prototype.close = function () { this._closed = true; };

  const sandbox2 = {
    console: console, setTimeout: setTimeout, clearTimeout: clearTimeout,
    setInterval: setInterval, clearInterval: clearInterval, Math: Math, Date: Date,
    performance: { now: function () { return Date.now(); } },
    JSON: JSON, Promise: Promise, Proxy: Proxy, Set: Set, Map: Map, Uint8Array: Uint8Array,
    navigator: { vibrate: function () {}, clipboard: { writeText: function () {} } },
    localStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    sessionStorage: { getItem: function () { return null; }, setItem: function () {}, removeItem: function () {} },
    document: doc2,
    getComputedStyle: function () { return { paddingTop: '0px', paddingBottom: '0px', paddingLeft: '0px', paddingRight: '0px', getPropertyValue: function () { return 'system-ui'; } }; },
    addEventListener: function () {}, Blob: function () {},
    URL: { createObjectURL: function () { return ''; }, revokeObjectURL: function () {} }
  };
  sandbox2.window = sandbox2;
  sandbox2.window.GomokuEngine = E;
  sandbox2.window.GomokuAI = {};
  sandbox2.window.GomokuNet = FakeNet;
  sandbox2.window.GomokuAudio = {
    place: function () { audio2.push('place'); },
    win: function () { audio2.push('win'); },
    lose: function () { audio2.push('lose'); },
    chat: function () {}, undo: function () {}, unlock: function () {}
  };
  sandbox2.window.GomokuStorage = {
    loadAll: function () { return []; },
    add: function (rec) { saved2.unshift(rec); return rec; },
    remove: function () {}, clear: function () {}, get: function () { return null; }
  };
  sandbox2.window.Peer = function () {}; // 让 peerAvailable=true，联机入口可用（FakeNet 接管业务）
  sandbox2.window.devicePixelRatio = 1;
  sandbox2.window.matchMedia = function () { return { matches: false }; };
  sandbox2.window.requestAnimationFrame = function (cb) { setTimeout(cb, 0); };

  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'), sandbox2, { filename: 'app.js' });

  const fire2 = function (id, type, opts) {
    const el = getEl2(id);
    const ev = opts || {}; ev.type = type; ev.target = el;
    el.dispatchEvent(ev);
  };

  // host 建房（模拟 createRoom：点「局域网建房」→ 昵称 → 创建）
  fire2('btn-lan-create', 'click');
  const nameInput = getEl2('m-name');
  nameInput.value = '房主';
  fire2('m-create-ok', 'click');
  assert(sandbox2.window.__net && netBroadcasts.length === 0, 'host 建房成功，FakeNet 已实例化');

  // 模拟收到 forbid 终局消息（client/观战者视角同构：同一 case 渲染）
  sandbox2.window.__net.fire({ type: 'forbid', forbid: '三三' });
  await tick();

  const m2 = getEl2('modal-card').innerHTML;
  assert(m2.indexOf('白方 胜') >= 0 && m2.indexOf('黑方禁手（三三）判负') >= 0, '收到 forbid 消息 → result modal 渲染"白方 胜 / 黑方禁手（三三）判负"');
  assert(getEl2('game-status').textContent === '黑方禁手判负', '联机终局状态条 = "黑方禁手判负"（实测 "' + getEl2('game-status').textContent + '"）');
  assert(netBroadcasts.length === 1 && netBroadcasts[0].type === 'forbid' && netBroadcasts[0].forbid === '三三',
    'host 权威广播 forbid 终局（type=forbid, forbid=三三）给远端/观战者');
  assert(saved2.length === 1 && saved2[0].result === 'white', 'host 落库历史记录 result="white"');
})();

// ─────────────────────────── 收尾 ───────────────────────────
setTimeout(function () {
  console.log('\n──────────────────────────────────────────');
  console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
  process.exit(fail > 0 ? 1 : 0);
}, 200);
