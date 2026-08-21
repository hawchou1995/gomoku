/**
 * app.js — 五子棋 UI 总控
 *
 * 职责：视图路由（首页/对局/历史）、Canvas 棋盘渲染、
 *       三种模式状态机（人机/局域网/互联网）、对局计时、
 *       聊天、历史记录与回放、音效触发。
 *
 * 联机一致性模型：host（房主）为权威节点。
 *   - 所有落子由 host 校验后广播（含观战者）；任何一端都只响应广播的 move
 *   - 悔棋/重开需对方同意；认输直接广播
 *   - 断线重连：client 自动重连，host 发 state-sync 快照恢复
 */
(function () {
  'use strict';

  var E = window.GomokuEngine;
  var AI = window.GomokuAI;
  var Net = window.GomokuNet;
  var A = window.GomokuAudio;
  var Store = window.GomokuStorage;

  var SIZE = E.SIZE;

  // ─────────────────────────── 全局状态 ───────────────────────────

  var state = {
    view: 'home',            // home | game | history
    mode: null,              // ai | lan | online
    game: new E.Game(),
    net: null,
    isHost: false,
    mySeat: 'black',         // black | white | spectator
    aiLevel: 4,
    myName: '玩家',
    roomCode: null,
    timers: { black: 0, white: 0 },
    ticker: null,
    lastMove: null,          // {x, y} 最后一手（标记用）
    pendingUndo: false,
    peerAvailable: typeof window.Peer !== 'undefined',
    playerFirst: true,       // 玩家先手（人机模式）
    forbidEnabled: false,    // 黑棋禁手
    swapEnabled: false,      // 三手交换（RIF：黑1天元，前三手后白方可换边）
    swapDecided: false,      // 前三手交换是否已裁决
    swapped: false,          // 是否已交换（玩家颜色互换）
    aiStarted: false         // 人机对局是否已开局（true 后规则开关锁定，重开后重新设置）
  };

  // ─────────────────────────── DOM 引用 ───────────────────────────

  var $ = function (id) { return document.getElementById(id); };
  var board = $('board');
  var ctx = board.getContext('2d');
  var boardCssSize = 0;   // 棋盘 CSS 像素边长
  var dpr = 1;
  var mouseCell = null;    // {x,y} 当前鼠标悬停的格子坐标（用于准星）
  var zoomLevel = 1;       // 棋盘缩放倍率（1 = 100%）
  var historySelected = {}; // 历史记录多选导出：{recordId: true}

  // ─────────────────────────── 视图路由 ───────────────────────────

  function showView(name) {
    ['home', 'game', 'history'].forEach(function (v) {
      $('view-' + v).classList.toggle('hidden', v !== name);
    });
    state.view = name;
    if (name === 'game') resizeBoard();
    if (name === 'history') renderHistory();
  }

  function goHome() {
    // 联机中离开需先断线
    if (state.net) { try { state.net.close(); } catch (e) { /* ignore */ } state.net = null; }
    stopTicker();
    state.game = new E.Game();
    state.mode = null;
    $('conn-indicator').classList.add('hidden');
    setImmersive(false);
    showView('home');
  }

  // ─────────────────────────── 沉浸式全屏（移动游戏 App 观感）───────────────────────────

  /**
   * 沉浸态开关：开局后（ai/pvp 点「开始对局」）棋盘全屏 + HUD 覆盖。
   * 移动端（≤860px）在开局手势内顺带请求系统全屏（浏览器允许）。
   */
  function setImmersive(on) {
    var was = document.body.classList.contains('immersive');
    document.body.classList.toggle('immersive', on);
    $('hud').classList.toggle('hidden', !on);
    if (on && !was) requestFullscreenIfMobile();
    if (!on && was) exitFullscreenIfNeeded();
    if (state.view === 'game') resizeBoard();
  }

  function requestFullscreenIfMobile() {
    if (!window.matchMedia('(max-width: 860px)').matches) return;
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.msRequestFullscreen;
    if (!fn) return;
    if (document.fullscreenElement || document.webkitFullscreenElement) return;
    try { fn.call(el); } catch (e) { /* iOS Safari 或权限拒绝：忽略 */ }
  }

  function exitFullscreenIfNeeded() {
    var fn = document.exitFullscreen || document.webkitExitFullscreen || document.msExitFullscreen;
    if (!fn) return;
    if (!document.fullscreenElement && !document.webkitFullscreenElement) return;
    try { fn.call(document); } catch (e) { /* ignore */ }
  }

  /** 移动端触觉反馈（不支持时静默）。 */
  function buzz(ms) {
    if (navigator.vibrate) { try { navigator.vibrate(ms || 15); } catch (e) { } }
  }

  // ─────────────────────────── Toast / Modal ───────────────────────────

  var toastTimer = null;
  function toast(msg, ms) {
    var t = $('toast');
    t.textContent = msg;
    t.classList.remove('hidden');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.add('hidden'); }, ms || 2600);
  }

  function openModal(html) {
    $('modal-root').classList.remove('hidden');
    $('modal-card').innerHTML = html;
    return function () { $('modal-root').classList.add('hidden'); };
  }

  $('modal-backdrop').addEventListener('click', function () {
    // 仅允许点击关闭普通提示类弹窗（通过 data-dismiss 标记）
    var card = $('modal-card');
    if (card.querySelector('[data-dismiss]')) $('modal-root').classList.add('hidden');
  });

  // 事件委托：弹窗内 data-dismiss 按钮点击关闭
  $('modal-card').addEventListener('click', function (ev) {
    if (ev.target.hasAttribute('data-dismiss') || ev.target.closest('[data-dismiss]')) {
      $('modal-root').classList.add('hidden');
    }
  });

  // ─────────────────────────── 棋盘渲染 ───────────────────────────

  function resizeBoard() {
    // 棋盘内容边长 = 滚动容器可视尺寸 × zoomLevel。
    // 普通态：仅按宽度（正方形）；沉浸态：HUD 上下占位约束高度，取宽/高较小值。
    var wrap = document.querySelector('.board-scroll');
    var baseW = wrap ? wrap.clientWidth : board.parentElement.clientWidth;
    var baseH = baseW;
    if (document.body.classList.contains('immersive') && wrap) {
      var cs = getComputedStyle(wrap);
      var padT = parseFloat(cs.paddingTop) || 0;
      var padB = parseFloat(cs.paddingBottom) || 0;
      var padL = parseFloat(cs.paddingLeft) || 0;
      var padR = parseFloat(cs.paddingRight) || 0;
      baseW = wrap.clientWidth - padL - padR;
      baseH = Math.max(120, wrap.clientHeight - padT - padB);
    }
    var applied = Math.round(Math.min(baseW, baseH) * zoomLevel);
    var bw = document.querySelector('.board-wrap');
    if (bw) { bw.style.width = applied + 'px'; bw.style.height = applied + 'px'; }
    boardCssSize = applied;
    dpr = window.devicePixelRatio || 1;
    board.width = Math.round(boardCssSize * dpr);
    board.height = Math.round(boardCssSize * dpr);
    drawBoard();
  }

  /** 缩放棋盘（0.5~3 倍），居中显示缩放比例。 */
  function setBoardZoom(z) {
    zoomLevel = Math.max(0.5, Math.min(3, z));
    var lb = $('zoom-label');
    if (lb) lb.textContent = Math.round(zoomLevel * 100) + '%';
    var ml = $('m-zoom-label'); // 沉浸态 ⋯ 菜单内的缩放标签
    if (ml) ml.textContent = Math.round(zoomLevel * 100) + '%';
    resizeBoard();
  }

  var BOARD_BG = '#e9e2d2';
  var LINE = '#5b5342';
  var LAST_MARK = '#d4a853';
  var WIN_OVERLAY = 'rgba(212, 168, 83, 0.28)';

  function cellPx() {
    // 15×15 网格：边距一个半格距
    return boardCssSize / (SIZE + 1);
  }

  function coordToPx(x, y) {
    var c = cellPx();
    return { px: c * (x + 1), py: c * (y + 1) };
  }

  function drawBoard(animateLast) {
    if (boardCssSize <= 0) return;
    var c = cellPx();
    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, boardCssSize, boardCssSize);

    // 棋盘底
    ctx.fillStyle = BOARD_BG;
    ctx.fillRect(0, 0, boardCssSize, boardCssSize);

    // 坐标轴标签（A-O 列，1-15 行）
    ctx.fillStyle = '#7a7260';
    ctx.font = (c * 0.36) + 'px ' + getComputedStyle(document.documentElement).getPropertyValue('--font').split(',')[0].trim();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (var i = 0; i < SIZE; i++) {
      var p = c * (i + 1);
      // 列标签 A-O（顶部）
      ctx.fillText(String.fromCharCode(65 + i), p, c * 0.45);
      // 列标签 A-O（底部）
      ctx.fillText(String.fromCharCode(65 + i), p, boardCssSize - c * 0.45);
      // 行标签 1-15（左侧）
      ctx.fillText(i + 1, c * 0.45, p);
      // 行标签 1-15（右侧）
      ctx.fillText(i + 1, boardCssSize - c * 0.45, p);
    }

    // 网格线
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    for (var xi = 0; xi < SIZE; xi++) {
      var p2 = c * (xi + 1);
      ctx.beginPath();
      ctx.moveTo(c, p2); ctx.lineTo(boardCssSize - c, p2);
      ctx.moveTo(p2, c); ctx.lineTo(p2, boardCssSize - c);
      ctx.stroke();
    }

    // 星位（天元 + 四角星）
    var stars = [[7, 7], [3, 3], [11, 3], [3, 11], [11, 11]];
    ctx.fillStyle = LINE;
    for (var si = 0; si < stars.length; si++) {
      var sp = coordToPx(stars[si][0], stars[si][1]);
      ctx.beginPath();
      ctx.arc(sp.px, sp.py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // 棋子（带步数标注）
    var g = state.game;
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var pl = E.get(g.board, x, y);
        if (pl === E.EMPTY) continue;
        drawStone(x, y, pl, 1);
      }
    }
    // 步数标注
    for (var mi = 0; mi < g.moves.length; mi++) {
      var m = g.moves[mi];
      var mp = coordToPx(m.x, m.y);
      ctx.fillStyle = m.player === E.BLACK ? '#d4a853' : '#5b5342';
      ctx.font = 'bold ' + (c * 0.34) + 'px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono').split(',')[0].trim();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(mi + 1, mp.px, mp.py);
    }

    // 最后一手标记
    if (state.lastMove) {
      var lp = coordToPx(state.lastMove.x, state.lastMove.y);
      ctx.strokeStyle = LAST_MARK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(lp.px, lp.py, c * 0.34, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 获胜线高亮
    if (g.over && g.over.line && g.over.line.length >= 5) {
      var line = g.over.line;
      var a = coordToPx(line[0].x, line[0].y);
      var b = coordToPx(line[4].x, line[4].y);
      ctx.strokeStyle = WIN_OVERLAY;
      ctx.lineWidth = c * 0.62;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(a.px, a.py);
      ctx.lineTo(b.px, b.py);
      ctx.stroke();
    }

    // 鼠标准星（发怒符号形似：⊗ 中心十字 + 四角锯齿）
    if (mouseCell && !g.over && E.get(g.board, mouseCell.x, mouseCell.y) === E.EMPTY) {
      var mp2 = coordToPx(mouseCell.x, mouseCell.y);
      var r = c * 0.38;
      ctx.strokeStyle = 'rgba(212,168,83,0.7)';
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      // 十字准星
      ctx.beginPath();
      ctx.moveTo(mp2.px - r, mp2.py); ctx.lineTo(mp2.px - r * 0.3, mp2.py);
      ctx.moveTo(mp2.px + r, mp2.py); ctx.lineTo(mp2.px + r * 0.3, mp2.py);
      ctx.moveTo(mp2.px, mp2.py - r); ctx.lineTo(mp2.px, mp2.py - r * 0.3);
      ctx.moveTo(mp2.px, mp2.py + r); ctx.lineTo(mp2.px, mp2.py + r * 0.3);
      ctx.stroke();
      // 四角斜线（形似发怒符号的角）
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      var s = r * 0.7;
      ctx.moveTo(mp2.px - r, mp2.py - r); ctx.lineTo(mp2.px - s, mp2.py - r); ctx.lineTo(mp2.px - r, mp2.py - s);
      ctx.moveTo(mp2.px + r, mp2.py - r); ctx.lineTo(mp2.px + s, mp2.py - r); ctx.lineTo(mp2.px + r, mp2.py - s);
      ctx.moveTo(mp2.px - r, mp2.py + r); ctx.lineTo(mp2.px - s, mp2.py + r); ctx.lineTo(mp2.px - r, mp2.py + s);
      ctx.moveTo(mp2.px + r, mp2.py + r); ctx.lineTo(mp2.px + s, mp2.py + r); ctx.lineTo(mp2.px + r, mp2.py + s);
      ctx.stroke();
    }

    ctx.restore();
  }

  function drawStone(x, y, p, scale) {
    var c = cellPx();
    var pos = coordToPx(x, y);
    var r = c * 0.42 * scale;
    ctx.save();
    ctx.translate(pos.px, pos.py);
    ctx.scale(scale, scale);
    if (p === E.BLACK) {
      var grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
      grad.addColorStop(0, '#454a55');
      grad.addColorStop(0.7, '#14161a');
      grad.addColorStop(1, '#0b0c10');
      ctx.fillStyle = grad;
    } else {
      grad = ctx.createRadialGradient(-r * 0.35, -r * 0.35, r * 0.1, 0, 0, r);
      grad.addColorStop(0, '#ffffff');
      grad.addColorStop(0.75, '#e6e0d2');
      grad.addColorStop(1, '#cfc8b8');
      ctx.fillStyle = grad;
    }
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = p === E.BLACK ? 'rgba(255,255,255,0.22)' : 'rgba(0,0,0,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  /** 落子动画：新子 0.6→1 弹性放大（约 140ms）。t 夹紧 [0,1]，防止 rAF 时间戳异常导致负半径崩溃。 */
  function animateStone(x, y, p, cb) {
    var t0 = performance.now();
    var dur = 140;
    function step(now) {
      var t = Math.min(1, Math.max(0, (now - t0) / dur));
      var k = Math.max(0.1, 0.6 + 0.4 * (1 - Math.pow(1 - t, 3))); // ease-out，下限保护
      drawBoard();
      drawStone(x, y, p, k);
      if (t < 1) requestAnimationFrame(step);
      else if (cb) cb();
    }
    requestAnimationFrame(step);
  }

  // ─────────────────────────── 计时器 ───────────────────────────

  function fmtClock(s) {
    var m = Math.floor(s / 60), ss = Math.floor(s % 60);
    return (m < 10 ? '0' : '') + m + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function renderClocks() {
    $('p-black-clock').textContent = fmtClock(state.timers.black);
    $('p-white-clock').textContent = fmtClock(state.timers.white);
    $('hud-p-black-clock').textContent = fmtClock(state.timers.black);
    $('hud-p-white-clock').textContent = fmtClock(state.timers.white);
  }

  /** host 权威计时：每秒给当前回合方 +1（人机/建房端）。 */
  function startTicker() {
    stopTicker();
    state.ticker = setInterval(function () {
      if (state.game.over) return;
      var seatOf = state.game.turn === E.BLACK ? 'black' : 'white';
      // 观战者不本地计时；client 也不计（以 host 广播为准），仅 host/人机本地计
      if (state.mode === 'ai' || state.isHost) {
        state.timers[seatOf]++;
        renderClocks();
      }
    }, 1000);
  }

  function stopTicker() {
    if (state.ticker) { clearInterval(state.ticker); state.ticker = null; }
  }

  // ─────────────────────────── 状态条 / 玩家栏 ───────────────────────────

  function seatName(seat) {
    if (state.mode === 'pvp') return seat === 'black' ? '黑方' : '白方';
    if (state.mode === 'ai') {
      if (myColor() === E.BLACK) return seat === 'black' ? '你' : 'AI ' + state.aiLevel + ' 段';
      return seat === 'black' ? 'AI ' + state.aiLevel + ' 段' : '你';
    }
    if (seat === 'black') return state.isHost ? state.myName + '（房主）' : '黑方';
    if (seat === 'white') return state.isHost ? '白方' : state.myName;
    return '观战者';
  }

  function renderPlayers(players) {
    // players: [{seat, name}]（联机）；名字同时同步到侧栏与沉浸 HUD
    var bn, wn;
    if (state.mode === 'pvp') { bn = '黑方'; wn = '白方'; }
    else if (state.mode === 'ai') {
      var youBlack = myColor() === E.BLACK;
      bn = youBlack ? '你' : 'AI ' + state.aiLevel + ' 段';
      wn = youBlack ? 'AI ' + state.aiLevel + ' 段' : '你';
    } else {
      bn = '黑方'; wn = '白方 · 等待加入';
      if (players) {
        players.forEach(function (pl) {
          if (pl.seat === 'black') bn = pl.name + (state.isHost ? '' : '');
          if (pl.seat === 'white') wn = pl.name;
        });
      }
    }
    $('p-black-name').textContent = bn;
    $('p-white-name').textContent = wn;
    $('hud-p-black-name').textContent = bn;
    $('hud-p-white-name').textContent = wn;
  }

  function updateStatus() {
    // 状态文本同时写入侧栏状态条与沉浸 HUD 状态胶囊（hud 附加样式类）
    var el = $('game-status');
    var hud = $('hud-status');
    var txt = '', cls = '';
    var g = state.game;
    if (g.over) {
      if (g.over.winner === 0) txt = '平局';
      else {
        var w = g.over.winner === E.BLACK ? '黑方' : '白方';
        txt = w + ' 获胜';
      }
      if (state.mode === 'ai') cls = (g.over.winner === myColor()) ? 'over-win' : 'over-lose';
    } else if (state.mode !== 'ai' && state.mode !== 'pvp' && !state.net) {
      txt = '连接中…';
    } else if (state.mode === 'ai' || state.mode === 'pvp') {
      // 未开局：状态条显示等待，不提示轮次
      if (!state.aiStarted) { txt = '等待开局…'; }
      else if (state.mode === 'ai') {
        var playerColor = myColor();
        if (g.turn === playerColor) { txt = '轮到你'; cls = 'turn-me'; }
        else { txt = 'AI 思考中…'; cls = 'thinking'; }
      }
      else txt = '轮到' + (g.turn === E.BLACK ? '黑方落子' : '白方落子');
    } else if (state.mySeat === 'spectator') {
      txt = '观战中';
    } else {
      var mine = (g.turn === E.BLACK) ? 'black' : 'white';
      txt = (mine === state.mySeat) ? '轮到你落子' : '等待对方落子';
      if (mine === state.mySeat) cls = 'turn-me';
    }
    el.textContent = txt;
    hud.textContent = txt;
    hud.className = 'hud-status' + (cls ? ' ' + cls : '');
  }

  function highlightTurn() {
    var aiNotStarted = (state.mode === 'ai' || state.mode === 'pvp') && !state.aiStarted;
    var seat = (state.game.over || aiNotStarted) ? null : (state.game.turn === E.BLACK ? 'black' : 'white');
    $('p-black').classList.toggle('active', seat === 'black');
    $('p-white').classList.toggle('active', seat === 'white');
    $('hud-p-black').classList.toggle('active', seat === 'black');
    $('hud-p-white').classList.toggle('active', seat === 'white');
  }

  function refreshUI() {
    updateStatus();
    highlightTurn();
    renderClocks();
    updateSetupLock();
    var g = state.game;
    var inNet = state.net && state.mySeat !== 'spectator';
    var localAct = state.mode === 'ai' || state.mode === 'pvp'; // 人机/本地双人当前设备即可操作
    var canAct = !g.over && (localAct ? true : inNet &&
      ((g.turn === E.BLACK ? 'black' : 'white') === state.mySeat));
    // 悔棋：人机/本地双人随时可悔；联机非观战、未结束、无待确认请求时可发起
    $('btn-undo').disabled = !(g.moves.length > 0 && !g.over && (localAct ? true : inNet && !state.pendingUndo));
    $('btn-resign').disabled = !(!g.over && (localAct ? true : inNet));
    $('btn-restart').disabled = !(localAct ? true : inNet);
    // 导出按钮：有落子即可导出
    $('btn-export-json').disabled = !(g.moves.length > 0);
    $('btn-export-csv').disabled = !(g.moves.length > 0);
    // 沉浸 HUD 操作条与侧栏按钮同状态（侧栏隐藏时仍由本函数统一驱动）
    $('btn-hud-undo').disabled = $('btn-undo').disabled;
    $('btn-hud-resign').disabled = $('btn-resign').disabled;
    $('btn-hud-restart').disabled = $('btn-restart').disabled;
    return canAct;
  }

  // ── 导出函数 ───────────────────────────

  function getCurrentGameRecord() {
    var g = state.game;
    return {
      mode: state.mode,
      level: state.mode === 'ai' ? state.aiLevel : null,
      players: {
        black: seatName('black'),
        white: state.mode === 'ai' ? seatName('white') : seatName('white')
      },
      result: g.over ? (g.over.winner === 0 ? 'draw' : (g.over.winner === E.BLACK ? 'black' : 'white')) : 'ongoing',
      moves: g.moves.map(function (m, i) { return { step: i + 1, x: m.x, y: m.y, col: String.fromCharCode(65 + m.x), row: m.y + 1, player: m.player === E.BLACK ? 'black' : 'white' }; }),
      durationMs: (state.timers.black + state.timers.white) * 1000
    };
  }

  function exportJSON(data, filename) {
    var json = JSON.stringify(data, null, 2);
    var blob = new Blob([json], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function exportCSV(data, filename) {
    var moves = data.moves;
    var lines = ['step,player,x,y,col,row'];
    for (var i = 0; i < moves.length; i++) {
      var m = moves[i];
      lines.push(m.step + ',' + m.player + ',' + m.x + ',' + m.y + ',' + m.col + ',' + m.row);
    }
    if (data.result !== 'ongoing') {
      lines.push(''); lines.push('result,' + data.result);
      lines.push('total_moves,' + moves.length);
    }
    var csv = '\uFEFF' + lines.join('\n'); // BOM 确保 Excel 中文兼容
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  function doExportCurrentJSON() {
    var rec = getCurrentGameRecord();
    var ts = new Date().toISOString().slice(0, 10);
    exportJSON(rec, 'gomoku-game-' + ts + '.json');
    toast('已导出 JSON');
  }

  function doExportCurrentCSV() {
    var rec = getCurrentGameRecord();
    var ts = new Date().toISOString().slice(0, 10);
    exportCSV(rec, 'gomoku-game-' + ts + '.csv');
    toast('已导出 CSV');
  }

  function doExportHistoryJSON() {
    var list = Store.loadAll();
    if (list.length === 0) { toast('暂无对局记录'); return; }
    var ts = new Date().toISOString().slice(0, 10);
    exportJSON(list, 'gomoku-history-' + ts + '.json');
    toast('已导出全部历史 JSON');
  }

  function doExportHistoryCSV() {
    var list = Store.loadAll();
    if (list.length === 0) { toast('暂无对局记录'); return; }
    var lines = ['id,mode,level,black,white,result,moves,created_at'];
    for (var i = 0; i < list.length; i++) {
      var r = list[i];
      lines.push([r.id, r.mode, r.level || '', r.players.black, r.players.white, r.result, r.moves.length, r.createdAt].join(','));
    }
    var csv = '\uFEFF' + lines.join('\n');
    var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var ts = new Date().toISOString().slice(0, 10);
    var a = document.createElement('a');
    a.href = url; a.download = 'gomoku-history-' + ts + '.csv'; a.click();
    URL.revokeObjectURL(url);
    toast('已导出全部历史 CSV');
  }

  // ─────────────────────────── 落子入口 ───────────────────────────

  function doMove(x, y) {
    var g = state.game;
    if (g.over) return;
    if (state.mode === 'ai' || state.mode === 'pvp') {
      // 【2026-08-16】未点「开始对局」禁止落子（进入对局界面仅确认设置，开局才落子）
      if (!state.aiStarted) { toast('请先点「开始对局」再落子'); return; }
      var mover = g.turn; // 当前回合方（黑/白）——本地双人即落子方，人机即玩家当前执子
      if (state.mode === 'ai') {
        // 人机：仅玩家回合本地落子
        var playerColor = myColor();
        if (g.turn !== playerColor) return;
      }
      // 三手交换开局：黑 1 必须天元（人机/本地双人均适用）
      if (state.swapEnabled && g.moves.length === 0 && !(x === 7 && y === 7)) {
        toast('三手交换规则：黑 1 必须落天元（H8）');
        return;
      }
      var r = g.play(x, y);
      if (!r.ok) {
        if (r.reason === 'forbid') { toast('禁手：' + r.forbid + '，不可落子'); return; }
        return;
      }
      A.place();
      state.lastMove = { x: x, y: y };
      animateStone(x, y, mover, drawBoard);
      // 【2026-08-16】三手交换裁决待定时（前三手齐、未裁决）不调度 AI——
      // decideSwap → applySwap 会根据裁决结果统一调度（否则与 doMove 的
      // scheduleAI 双定时器竞态：AI 连落两手，第二手回合错位 → 换手后玩家无法落子）
      var swapPending = state.swapEnabled && !state.swapDecided && state.game.moves.length === 3 && !g.over;
      afterLocalMove(r);
      if (!g.over && !swapPending && state.mode === 'ai') scheduleAI();
    } else if (state.net) {
      // 联机：任何端都只发请求给 host（host 直接本地执行 + 广播）
      if (state.mySeat === 'spectator') return;
      if ((g.turn === E.BLACK ? 'black' : 'white') !== state.mySeat) return;
      state.net.send('move', { x: x, y: y });
    }
  }

  function afterLocalMove(r) {
    buzz(15); // 移动端触觉反馈
    refreshUI();
    // 三手交换：前三手落定且未裁决时触发
    if (state.swapEnabled && !state.swapDecided && state.game.moves.length === 3 && !state.game.over) {
      decideSwap();
      return;
    }
    if (r.over) {
      A.place();
      exportReplayForLearning();
      setTimeout(function () {
        if (r.over.winner === 0) { A.lose(); showGameOver(r.over, true); }
        else {
          var playerColor = myColor();
          var iWin = (r.over.winner === playerColor) ||
                     (r.over.winner === E.BLACK && state.mySeat === 'black') ||
                     (r.over.winner === E.WHITE && state.mySeat === 'white');
          if (iWin) A.win(); else A.lose();
          showGameOver(r.over, iWin);
        }
      }, 300);
      saveHistory(r.over);
    }
  }

  /**
   * 三手交换裁决：前三手（黑1天元、白1、黑2）落定后，白方选择交换执黑。
   * 玩家执白 → 弹窗确认；玩家执黑（AI 执白）→ AI 用评估函数自动决定（黑显著占优才换）。
   * 交换 = 换边续下，棋盘上已有 3 子颜色不变。
   */
  function decideSwap() {
    state.swapDecided = true;
    // pvp：白方即另一位玩家，由其真人裁决；人机：玩家执白才弹窗，AI 执白自动裁决
    var playerIsWhite = (state.mode === 'pvp') ? true : (myColor() === E.WHITE && !state.swapped);
    if (playerIsWhite) {
      var closeSw = openModal(
        '<div class="modal-title">三手交换</div>' +
        '<div class="modal-body">黑方前三手已落（黑 1 天元）。作为白方，你可以选择交换执黑（棋盘不变，换边续下）。</div>' +
        '<div class="modal-actions">' +
        '<button class="btn outline" id="sw-no">继续执白</button>' +
        '<button class="btn primary" id="sw-yes">交换执黑</button>' +
        '</div>'
      );
      $('sw-yes').addEventListener('click', function () { closeSw(); applySwap(true); });
      $('sw-no').addEventListener('click', function () { closeSw(); applySwap(false); });
    } else {
      // AI 执白：自动裁决——RIF 理性白方：黑布局不劣（黑评估≥白）即交换执黑。
      // 黑先手本身有价值，对称/均势局面 AI 拿黑也不吃亏；黑布局明显差（白优）不换。
      // 【2026-08-16】6000 阈值（中盘量级）→ 前三手永达不到（0/8）；sb>sw 对对称
      // 局面（差=0，如黑2 落(9,8)/(8,9)）不换 → 用户随手布局时感知"换手未生效"
      // → 改 sb>=sw：黑不劣即交换（测试集 15 局面中对称局面差恒为 0）。
      var g = state.game;
      var sb = AI._evaluate(g.board, E.BLACK);
      var sw = AI._evaluate(g.board, E.WHITE);
      var swap = sb >= sw;
      setTimeout(function () {
        applySwap(swap);
      }, 500);
    }
  }

  function applySwap(doSwap) {
    state.swapped = doSwap;
    if (state.mode === 'ai' || state.mode === 'pvp') renderPlayers(null); // 玩家名随执子刷新
    refreshUI();
    if (doSwap) toast(state.mode === 'pvp' ? '已交换：白方改执黑续下' : (state.playerFirst ? '你改执白，AI 执黑' : 'AI 改执白，你执黑'));
    else toast('不交换，继续当前执子');
    if (!state.game.over) {
      // 交换后仍由当前回合方续下（原白方执黑 / 原黑方执白）；人机再补 AI 调度
      var next = myColor() === state.game.turn;
      if (state.mode === 'ai' && !next) scheduleAI();
      else drawBoard();
    }
  }

  // 【2026-08-16】AI 落子定时器统一管理：重开/再来一局时必须清除挂起的
  // AI 任务，否则旧任务的 setTimeout 会在新对局上执行（时序竞态 → AI 先手
  // 新局卡"AI 思考中"、落子错位等）。startNewGame 时统一清除。
  var aiTimers = [];
  function clearAiTimers() {
    for (var i = 0; i < aiTimers.length; i++) { try { clearTimeout(aiTimers[i]); } catch (e) { } }
    aiTimers = [];
  }

  // ── 异步 AI 思考（2026-08-18）：Web Worker 跑九段长思考，主线程不卡 ──
  // Worker 不可用（file:// 或加载失败）时自动回退同步调用（同一时间预算）。
  var aiWorker = null;
  var aiWorkerSeq = 0;
  var aiWorkerPending = {};
  function initAiWorker() {
    if (aiWorker !== null) return aiWorker !== false;
    try {
      if (typeof Worker === 'undefined') { aiWorker = false; return false; }
      aiWorker = new Worker('js/ai_worker.js');
      aiWorker.onmessage = function (ev) {
        var d = ev.data;
        var cb = aiWorkerPending[d.id];
        if (cb) { delete aiWorkerPending[d.id]; cb(d.move, d.error); }
      };
      aiWorker.onerror = function () { aiWorker = false; };
      return true;
    } catch (e) {
      aiWorker = false;
      return false;
    }
  }
  /**
   * 异步求 AI 最佳落子。
   * think(board, player, level, ms, forbidEnabled, history, cb(move, err))
   * 优先 Worker；Worker 加载模型较重（3.6MB），首次思考前有准备期，之后每次请求即时。
   */
  function think(board, player, level, ms, forbidEnabled, history, cb) {
    if (initAiWorker()) {
      var id = ++aiWorkerSeq;
      aiWorkerPending[id] = cb;
      try {
        aiWorker.postMessage({
          id: id,
          board: Array.prototype.slice.call(board), // Uint8Array → 普通数组（结构化克隆）
          player: player,
          level: level,
          ms: ms,
          forbidEnabled: !!forbidEnabled,
          history: history || []
        });
        return;
      } catch (e) { delete aiWorkerPending[id]; /* fallthrough 到同步 */ }
    }
    // 同步兜底
    var mv;
    try { mv = AI.getBestMove(board, player, level, Date.now() + ms, forbidEnabled, history); }
    catch (e) { mv = null; }
    setTimeout(function () { cb(mv, null); }, 0);
  }
  /** Worker 思考时也要防"对局已结束/换局"的过期落子：回调内二次校验。 */
  function aiTurnValid() {
    return state.mode === 'ai' && state.aiStarted && !state.game.over;
  }

  function scheduleAI() {
    // 延迟 300ms 起，段位越高延迟略增（心理感）
    var delay = 300 + state.aiLevel * 80;
    var aiColor = E.opp(myColor());
    var t = setTimeout(function () {
      // 【2026-08-16】未点「开始对局」禁止 AI 落子（与 doMove 玩家守卫对称；
      // 防御性：正常流程中玩家落不了子 AI 就不会被调度，防止任何残留定时器乱局）
      if (state.game.over || state.mode !== 'ai' || !state.aiStarted) return;
      // 三手交换开局：AI 执黑第 1 手强制天元
      if (state.swapEnabled && state.game.moves.length === 0) {
        var mv0 = { x: 7, y: 7 };
        var r0 = state.game.play(mv0.x, mv0.y);
        if (!r0.ok) return;
        A.place();
        state.lastMove = { x: mv0.x, y: mv0.y };
        animateStone(mv0.x, mv0.y, aiColor, drawBoard);
        afterLocalMove(r0);
        return;
      }
      // 【2026-08-18 异步长思考】九段 6500ms 走 Worker，主线程不卡；
      // 思考期间若对局被重开/结束，回调内 aiTurnValid() 拦截过期落子。
      var movesAtRequest = state.game.moves.length;
      var hist = state.game.moves.map(function (m) {
        return { x: m.x, y: m.y, player: m.player };
      });
      var budget = (AI.TIME_BUDGETS && AI.TIME_BUDGETS[state.aiLevel - 1]) || 2500;
      think(state.game.board, aiColor, state.aiLevel, budget, state.forbidEnabled, hist, function (mv) {
        if (!mv || !aiTurnValid()) return;
        // 思考期间有人悔棋/重开 → moves 长度变了 → 丢弃过期结果（不重放）
        if (state.game.moves.length !== movesAtRequest) return;
        var r = state.game.play(mv.x, mv.y);
        if (!r.ok) return;
        A.place();
        state.lastMove = { x: mv.x, y: mv.y };
        animateStone(mv.x, mv.y, aiColor, drawBoard);
        afterLocalMove(r);
      });
    }, delay);
    aiTimers.push(t);
    if (aiTimers.length > 30) aiTimers.shift();
  }

  // ─────────────────────────── 联机消息处理 ───────────────────────────

  /**
   * 统一的联机消息入口（host 与 client 共用）。
   * @param msg 消息对象
   * @param fromSeat 来源席位（host 视角；client 视角为 mySeat）
   */
  function handleNetMessage(msg, fromSeat) {
    var g = state.game;
    switch (msg.type) {

      case 'move': {
        if (state.isHost) {
          // host 权威：校验来源回合后执行并广播（覆盖 host 本地落子与 client 转发）
          var seatOfTurn = g.turn === E.BLACK ? 'black' : 'white';
          if (fromSeat !== state.mySeat && seatOfTurn !== fromSeat) return; // 非本方回合，丢弃
          var r = g.play(msg.x, msg.y);
          if (!r.ok) return;
          A.place();
          state.lastMove = { x: msg.x, y: msg.y };
          state.net.broadcast('move', { x: msg.x, y: msg.y, seq: g.seq, timers: state.timers });
          afterLocalMove(r);
          return;
        }
        // client / 观战者收到广播：应用
        var r2 = g.play(msg.x, msg.y);
        if (!r2.ok) return;
        if (msg.timers) state.timers = msg.timers;
        buzz(15); // 移动端触觉反馈
        A.place();
        state.lastMove = { x: msg.x, y: msg.y };
        var mover = g.moves.length ? g.moves[g.moves.length - 1].player : E.BLACK;
        animateStone(msg.x, msg.y, mover, function () { refreshUI(); });
        if (r2.over) {
          setTimeout(function () {
            var w = r2.over.winner;
            var iWin = (w === E.BLACK && state.mySeat === 'black') || (w === E.WHITE && state.mySeat === 'white');
            if (iWin) A.win(); else A.lose();
            showGameOver(r2.over, iWin, 'remote');
          }, 300);
        } else {
          refreshUI();
        }
        return;
      }

      case 'chat': {
        A.chat();
        appendChat(msg.from, msg.text, false);
        // host 转发给所有人（含来源端，由回路统一渲染，各端恰好显示一次）
        if (state.isHost) state.net.broadcast('chat', { from: msg.from, text: msg.text });
        return;
      }

      case 'undo-req': {
        if (state.isHost) {
          // host 收到 client 的悔棋请求：host 是对手，弹确认；同意后直接执行
          var closeH = openModal(
            '<div class="modal-title">悔棋请求</div>' +
            '<div class="modal-body">对方请求悔棋，撤销最后一步。是否同意？</div>' +
            '<div class="modal-actions">' +
            '<button class="btn outline" id="m-no">拒绝</button>' +
            '<button class="btn primary" id="m-yes">同意</button>' +
            '</div>'
          );
          $('m-no').addEventListener('click', function () {
            state.pendingUndo = false;
            closeH(); refreshUI();
            state.net.sendTo(fromSeat, 'undo-no', {});
          });
          $('m-yes').addEventListener('click', function () {
            state.pendingUndo = false;
            closeH(); refreshUI();
            var removed = g.undo(1);
            if (removed > 0) {
              A.undo();
              state.lastMove = g.moves.length ? { x: g.moves[g.moves.length - 1].x, y: g.moves[g.moves.length - 1].y } : null;
              state.net.broadcast('undo-done', { timers: state.timers });
              drawBoard(); refreshUI();
            }
          });
          return;
        }
        // client 收到 host 的悔棋请求：client 是对手，弹确认；同意后通知 host 执行
        state.pendingUndo = true;
        refreshUI();
        var close = openModal(
          '<div class="modal-title">悔棋请求</div>' +
          '<div class="modal-body">对方请求悔棋，撤销最后一步。是否同意？</div>' +
          '<div class="modal-actions">' +
          '<button class="btn outline" id="m-no">拒绝</button>' +
          '<button class="btn primary" id="m-yes">同意</button>' +
          '</div>'
        );
        $('m-no').addEventListener('click', function () {
          state.pendingUndo = false;
          close(); refreshUI();
          state.net.send('undo-no', {});
        });
        $('m-yes').addEventListener('click', function () {
          state.pendingUndo = false;
          close(); refreshUI();
          state.net.send('undo-ok', {});
        });
        return;
      }

      case 'undo-ok': {
        // host 收到 client 同意 → 执行悔棋并广播
        if (state.isHost) {
          state.pendingUndo = false;
          var removed = g.undo(1);
          if (removed > 0) {
            A.undo();
            state.lastMove = g.moves.length ? { x: g.moves[g.moves.length - 1].x, y: g.moves[g.moves.length - 1].y } : null;
            state.net.broadcast('undo-done', { timers: state.timers });
            drawBoard(); refreshUI();
          }
        }
        return;
      }

      case 'undo-no': {
        state.pendingUndo = false;
        toast('对方拒绝了悔棋');
        refreshUI();
        return;
      }

      case 'undo-done': {
        g.undo(1);
        if (msg.timers) state.timers = msg.timers;
        A.undo();
        state.lastMove = g.moves.length ? { x: g.moves[g.moves.length - 1].x, y: g.moves[g.moves.length - 1].y } : null;
        drawBoard(); refreshUI();
        return;
      }

      case 'resign': {
        // 谁认输：以消息携带的 loser / seat 为准（host 权威）
        var loser = msg.loser || msg.seat || fromSeat;
        var winner = loser === 'black' ? E.WHITE : E.BLACK;
        g.over = { winner: winner, line: null, reason: 'resign' };
        var iResignWin = winner === E.BLACK ? state.mySeat === 'black' : state.mySeat === 'white';
        if (iResignWin) A.win(); else A.lose();
        showGameOver(g.over, iResignWin, 'remote');
        drawBoard();
        // host 落库并广播给 client（观战者也收到）
        if (state.isHost) {
          saveHistory(g.over, 'remote');
          state.net.broadcast('resign', { loser: loser });
        }
        refreshUI();
        return;
      }

      case 'restart-req': {
        if (fromSeat === state.mySeat) return;
        var close2 = openModal(
          '<div class="modal-title">重新开局</div>' +
          '<div class="modal-body">对方请求重新开始一局。是否同意？</div>' +
          '<div class="modal-actions">' +
          '<button class="btn outline" id="m-no2">拒绝</button>' +
          '<button class="btn primary" id="m-yes2">同意</button>' +
          '</div>'
        );
        $('m-no2').addEventListener('click', function () { close2(); state.net.send('restart-no', {}); });
        $('m-yes2').addEventListener('click', function () { close2(); state.net.send('restart-ok', {}); });
        return;
      }

      case 'restart-ok': {
        if (state.isHost) {
          startNewGame(true); // 重置计时
          state.net.broadcast('restart-done', { timers: state.timers });
        }
        return;
      }

      case 'restart-no': {
        toast('对方拒绝了重新开局');
        return;
      }

      case 'restart-done': {
        startNewGame(true);
        if (msg.timers) state.timers = msg.timers;
        return;
      }

      case 'player-list': {
        renderPlayers(msg.players);
        return;
      }

      default:
        return;
    }
  }

  // ─────────────────────────── 人机 / 联机启动 ───────────────────────────

  function startNewGame(resetTimers) {
    clearAiTimers(); // 【2026-08-16】清除挂起的 AI 落子任务（重开竞态防护）
    state.game = new E.Game();
    state.game.forbidEnabled = state.forbidEnabled;
    state.lastMove = null;
    state.pendingUndo = false;
    state.swapDecided = false;
    state.swapped = false;
    if (resetTimers) { state.timers = { black: 0, white: 0 }; }
    drawBoard();
    refreshUI();
  }

  /** 玩家当前执子颜色（考虑三手交换）。 */
  function myColor() {
    var c = state.playerFirst ? E.BLACK : E.WHITE;
    return state.swapped ? E.opp(c) : c;
  }

  /**
   * 开局设置区（对局界面内）状态：仅人机模式显示；开局后锁定、结束后解锁。
   * 每次 refreshUI 调用，保证「进入对局可调 → 落子锁定 → 结束解锁改设置再开」闭环。
   */
  function updateSetupLock() {
    var showSetup = state.mode === 'ai' || state.mode === 'pvp';
    $('ai-setup').style.display = showSetup ? '' : 'none';
    var isAi = state.mode === 'ai';
    // 本地双人无"玩家先手"概念（黑先白后固定），也无 AI 段位；隐藏对应行
    var firstRow = $('toggle-first-row'), levelRow = $('setup-level-row');
    if (firstRow) firstRow.style.display = isAi ? '' : 'none';
    if (levelRow) levelRow.style.display = isAi ? '' : 'none';
    var locked = showSetup && state.aiStarted && !state.game.over;
    if ($('toggle-first')) $('toggle-first').disabled = locked;
    $('toggle-forbid').disabled = locked;
    $('toggle-swap').disabled = locked;
    if ($('toggle-first-row')) $('toggle-first-row').classList.toggle('disabled', locked);
    $('toggle-forbid-row').classList.toggle('disabled', locked);
    $('toggle-swap-row').classList.toggle('disabled', locked);
    $('btn-start-ai').disabled = locked;
    // 段位按钮在开局后锁定
    var lbtns = document.querySelectorAll('.ai-setup .level-btn');
    lbtns.forEach(function (b) { b.disabled = locked; });
  }

  /**
   * 进入人机对局界面（不落子）。
   * 【2026-08-16 重构】开关 + 开始对局按钮从大厅移回对局界面：大厅选段位 → 进入对局
   * 界面确认三个开关 → 点「开始对局」才真正开局。开局前开关可自由调整。
   */
  function enterAIGame(level) {
    goHomeInternal();
    state.mode = 'ai';
    state.isHost = false;
    state.mySeat = state.playerFirst ? 'black' : 'white';
    state.aiLevel = level;
    state.aiStarted = false;
    startNewGame(true);
    setImmersive(false); // 设置态用侧栏，开局后才全屏
    showView('game');
    $('conn-indicator').classList.add('hidden');
    $('chat-box').style.display = 'none';
    renderPlayers(null);
    updateSetupLock();
    toast('请确认下方设置，点「开始对局」开局');
  }

  /** 点「开始对局」：按当前开关设置真正开局（棋盘有残局则先清盘）。 */
  function beginAIGame() {
    if (state.mode !== 'ai') return;
    // 对局进行中禁止重开（按钮已禁用，双保险）
    if (state.aiStarted && !state.game.over) return;
    state.aiStarted = true;
    if (state.game.moves.length > 0) startNewGame(true); // 上一局残局清盘
    state.mySeat = state.playerFirst ? 'black' : 'white';
    renderPlayers(null);
    if (state.playerFirst) {
      startTicker();
      toast(state.swapEnabled ? '人机对战 · ' + state.aiLevel + ' 段，你执黑先行（黑 1 天元，前三手后白方可交换）' : '人机对战 · ' + state.aiLevel + ' 段，你执黑先行');
    } else {
      // AI 先手，立刻让它落子
      toast(state.swapEnabled ? '人机对战 · ' + state.aiLevel + ' 段，AI 执黑先行（黑 1 天元）' : '人机对战 · ' + state.aiLevel + ' 段，AI 执黑先行');
      aiFirstMove();
    }
    refreshUI(); // 【2026-08-16】开局后刷新状态条/开关锁定（aiStarted 已置位；新开局无残局时不走 startNewGame，此前状态条停留在「等待开局…」）
    setImmersive(true); // 【2026-08-21】开局 → 棋盘全屏沉浸 + HUD 覆盖
  }

  /**
   * 进入本地双人对局界面（不落子）。
   * 段位/先手开关在开局设置区；本地双人固定黑先白后，可选禁手/三手交换。
   */
  function enterPvpGame() {
    goHomeInternal();
    state.mode = 'pvp';
    state.isHost = false;
    state.playerFirst = true; // 本地双人固定黑先
    state.aiLevel = 4;
    state.aiStarted = false;
    state.swapDecided = false;
    state.swapped = false;
    startNewGame(true);
    setImmersive(false); // 设置态用侧栏，开局后才全屏
    showView('game');
    $('conn-indicator').classList.add('hidden');
    $('chat-box').style.display = 'none';
    renderPlayers(null);
    updateSetupLock();
    toast('本地双人：黑先白后，请确认下方设置，点「开始对局」开局');
  }

  /** 点「开始对局」：本地双人真正开局（残局先清盘）。 */
  function beginPvpGame() {
    if (state.mode !== 'pvp') return;
    if (state.aiStarted && !state.game.over) return;
    state.aiStarted = true;
    if (state.game.moves.length > 0) startNewGame(true);
    renderPlayers(null);
    startTicker();
    toast(state.swapEnabled ? '本地双人 · 黑先白后（黑 1 天元，前三手后白方可交换）' : '本地双人 · 黑先白后');
    refreshUI();
    setImmersive(true); // 【2026-08-21】开局 → 棋盘全屏沉浸 + HUD 覆盖
  }

  /**
   * AI 先手首步（playerFirst=false 且未交换时）：AI 执黑落第 1 手。
   * 供 beginAIGame / doRestart / 「再来一局」统一调用——此前重开/再来一局
   * 只 startNewGame 不触发 AI 落子，AI 先手时新局无人落子（死局）。
   */
  function aiFirstMove() {
    // 【2026-08-16】guard 不再拦截 swapped：startNewGame 已重置，且对局中若有交换
    // 状态残留会误拦 AI 先手首步（用户反馈"取消玩家先手后 AI 不落子"的潜在来源之一）
    if (state.mode !== 'ai' || state.playerFirst || state.game.over || !state.aiStarted) return;
    // 兜底重试：400ms 后若因任何原因未落子，再试一次（共 2 次）
    var attempt = 0;
    var doIt = function () {
      if (state.mode !== 'ai' || state.playerFirst || state.game.over) return;
      if (attempt++ >= 2) return;
      if (state.swapEnabled) {
        var r0 = state.game.play(7, 7);
        if (r0.ok) {
          A.place();
          state.lastMove = { x: 7, y: 7 };
          animateStone(7, 7, E.BLACK, drawBoard);
          afterLocalMove(r0);
          startTicker();
          drawBoard(); refreshUI();
        }
        return;
      }
      // 【2026-08-18 异步】AI 先手首步也用 Worker 长思考（九段可深算开局）
      var budget = (AI.TIME_BUDGETS && AI.TIME_BUDGETS[state.aiLevel - 1]) || 2500;
      think(state.game.board, E.BLACK, state.aiLevel, budget, state.forbidEnabled, [], function (mv) {
        if (!mv || state.mode !== 'ai' || state.playerFirst || state.game.over) return;
        if (!state.aiStarted) return;
        var r = state.game.play(mv.x, mv.y);
        if (!r.ok) { setTimeout(doIt, 300); return; }
        A.place();
        state.lastMove = { x: mv.x, y: mv.y };
        animateStone(mv.x, mv.y, E.BLACK, drawBoard);
        afterLocalMove(r);
        startTicker();
        drawBoard(); refreshUI();
      });
    };
    var t0 = setTimeout(doIt, 400);
    aiTimers.push(t0);
  }

  /** 与 goHome 类似但保留 mode 的清理（建房/加入前调用）。 */
  function goHomeInternal() {
    if (state.net) { try { state.net.close(); } catch (e) { /* ignore */ } state.net = null; }
    stopTicker();
  }

  function createRoom(mode, name) {
    goHomeInternal();
    state.mode = mode;
    state.isHost = true;
    state.mySeat = 'black';
    state.myName = name || '房主';
    state.roomCode = Net.genRoomCode();
    startNewGame(true);
    showView('game');
    $('chat-box').style.display = '';
    // 开局设置区仅人机模式显示（updateSetupLock 统一管理）

    state.net = new Net({
      getMyName: function () { return state.myName; },
      getSnapshot: function () {
        return {
          moves: state.game.moves,
          turn: state.game.turn,
          over: state.game.over,
          seq: state.game.seq,
          timers: state.timers
        };
      },
      onStatus: onNetStatus,
      onMessage: function (msg, fromSeat) { handleNetMessage(msg, fromSeat); }
    });

    state.net.createRoom(state.roomCode, state.myName);
    startTicker();
    renderPlayers([{ seat: 'black', name: state.myName }]);
  }

  function joinRoom(mode, code, name) {
    goHomeInternal();
    state.mode = mode;
    state.isHost = false;
    state.mySeat = null; // 待 welcome 分配
    state.myName = name || '玩家';
    state.roomCode = code.toUpperCase();
    startNewGame(true);
    showView('game');
    $('chat-box').style.display = '';
    // 开局设置区仅人机模式显示（updateSetupLock 统一管理）

    // 断线重连身份：同一房间码 + 同一标签页会话，优先恢复原席位
    var sid = null;
    try { sid = sessionStorage.getItem('gomoku_sid_' + state.roomCode); } catch (e) { /* ignore */ }

    state.net = new Net({
      getMyName: function () { return state.myName; },
      onStatus: onNetStatus,
      onMessage: function (msg) { handleNetMessage(msg, 'black'); } // client 收到的消息均来自 host
    });
    state.net.joinRoom(state.roomCode, { name: state.myName, sid: sid });
    updateStatus();
  }

  function onNetStatus(type, payload) {
    var ind = $('conn-indicator');
    switch (type) {
      case 'host-ready':
        ind.classList.remove('hidden', 'err');
        ind.classList.add('ok');
        ind.textContent = '房间 ' + state.roomCode;
        openRoomModal(true);
        break;
      case 'client-open':
        ind.classList.remove('hidden', 'err');
        ind.classList.add('ok');
        ind.textContent = '房间 ' + state.roomCode;
        break;
      case 'welcome':
        state.mySeat = payload.seat;
        // 持久化重连身份（同一标签页会话内刷新可恢复）
        try { sessionStorage.setItem('gomoku_sid_' + state.roomCode, state.net.mySid); } catch (e) { /* ignore */ }
        // 观战者不参与计时
        if (payload.seat === 'spectator') stopTicker();
        if (payload.seat === 'white') startTicker();
        if (payload.snapshot) applySnapshot(payload.snapshot);
        toast(payload.seat === 'spectator' ? '已以观战身份加入房间' : '已加入房间，你执' + (payload.seat === 'white' ? '白' : '黑') + '棋');
        refreshUI();
        break;
      case 'reconnected':
        state.mySeat = payload.seat;
        if (payload.snapshot) applySnapshot(payload.snapshot);
        toast('已重连，对局已恢复');
        if (payload.seat !== 'spectator') startTicker();
        refreshUI();
        break;
      case 'peer-joined':
        if (payload.seat === 'white') {
          toast(payload.name + ' 加入了房间，对局开始');
          renderPlayers([{ seat: 'black', name: state.myName }, { seat: 'white', name: payload.name }]);
        } else {
          toast(payload.name + ' 以观战身份加入');
        }
        break;
      case 'peer-left':
        if (payload.reconnecting) {
          toast(payload.name + ' 连接中断，等待重连（90 秒）…');
        } else if (payload.seat === 'spectator') {
          toast('观战者 ' + payload.name + ' 已离开');
        }
        break;
      case 'peer-timeout':
        toast(payload.name + ' 超时未归，判负');
        if (state.isHost && !state.game.over) {
          // 超时方判负：广播 resign（loser = 超时席位）
          handleNetMessage({ type: 'resign', loser: payload.seat }, payload.seat);
        }
        break;
      case 'reconnecting':
        ind.classList.remove('ok');
        ind.classList.add('err');
        ind.textContent = '重连中 (' + payload.attempt + ')';
        toast('连接断开，正在重连…');
        break;
      case 'reconnect-attempt':
        ind.textContent = '重连中 (' + payload.attempt + ')';
        break;
      case 'error':
        if (payload.type === 'room-not-found') {
          toast('房间不存在或已关闭');
        } else {
          toast('连接错误：' + (payload.message || payload.type));
        }
        ind.classList.remove('ok');
        ind.classList.add('err');
        ind.textContent = '连接异常';
        break;
      default:
        break;
    }
  }

  function applySnapshot(snap) {
    if (!snap) return;
    state.game.load(snap);
    if (snap.timers) state.timers = snap.timers;
    state.lastMove = snap.moves && snap.moves.length
      ? { x: snap.moves[snap.moves.length - 1].x, y: snap.moves[snap.moves.length - 1].y }
      : null;
    drawBoard();
    refreshUI();
    if (snap.over) showGameOver(snap.over, false, 'replay');
  }

  // ─────────────────────────── 房间弹窗 ───────────────────────────

  function openRoomModal(created) {
    if (!created) return;
    var roomCode = state.roomCode;
    var close = openModal(
      '<div class="modal-title">房间已创建</div>' +
      '<div class="modal-body">' +
      '将房间码发给对方：' +
      '<span class="room-code" data-copy>' + roomCode + '</span>' +
      '对方在「' + (state.mode === 'lan' ? '局域网联机' : '互联网联机') + '」中选择加入房间并输入此码。' +
      '同局域网可直接对战；跨网络同样适用（P2P 直连）。' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn primary" data-dismiss>知道了</button>' +
      '</div>'
    );
    var codeEl = $('modal-card').querySelector('[data-copy]');
    if (codeEl) {
      codeEl.addEventListener('click', function () {
        try { navigator.clipboard.writeText(roomCode); toast('房间码已复制'); } catch (e) { /* ignore */ }
      });
    }
    // 首次显示 5 秒后自动关闭，避免挡住棋盘
    setTimeout(function () { close(); }, 5000);
  }

  // ─────────────────────────── 操作按钮 ───────────────────────────

  function doUndo() {
    var g = state.game;
    if (state.mode === 'ai' || state.mode === 'pvp') {
      if (g.moves.length < 1) return;
      if (state.mode === 'ai') {
        // AI 先手：撤 1 步（AI 的）→ 玩家落子；玩家先手：撤 2 步（玩家+AI 的回合约）
        if (state.playerFirst) {
          if (g.moves.length < 2) return;
          g.undo(2);
        } else {
          if (g.moves.length < 1) return;
          g.undo(1);
        }
      } else {
        // 本地双人：撤 1 步（当前回合方落子）
        g.undo(1);
      }
      A.undo();
      state.lastMove = g.moves.length ? { x: g.moves[g.moves.length - 1].x, y: g.moves[g.moves.length - 1].y } : null;
      drawBoard(); refreshUI();
      toast('已悔棋，' + (g.turn === E.BLACK ? '黑方' : '白方') + '落子');
      return;
    }
    if (state.net && !state.pendingUndo) {
      state.pendingUndo = true;
      refreshUI();
      if (state.isHost) {
        state.net.sendTo(state.mySeat === 'black' ? 'white' : 'black', 'undo-req', {});
      } else {
        state.net.send('undo-req', {});
      }
      toast('已发送悔棋请求，等待对方…');
    }
  }

  function doResign() {
    var g = state.game;
    if (g.over) return;
    // 【2026-08-16】未点「开始对局」时认输无效
    if ((state.mode === 'ai' || state.mode === 'pvp') && !state.aiStarted) { toast('对局尚未开始'); return; }
    if (state.mode === 'ai') {
      g.over = { winner: E.WHITE, line: null, reason: 'resign' };
      A.lose();
      showGameOver(g.over, false);
      saveHistory(g.over);
      refreshUI();
      return;
    }
    if (state.mode === 'pvp') {
      // 本地双人：任一方认输，由按下认输的一方选择谁认输
      var close2 = openModal(
        '<div class="modal-title">认输</div>' +
        '<div class="modal-body">哪一方认输？认输方判负，另一方获胜。</div>' +
        '<div class="modal-actions">' +
        '<button class="btn outline" data-dismiss>取消</button>' +
        '<button class="btn outline" id="m-resign-black">黑方认输</button>' +
        '<button class="btn primary" id="m-resign-white">白方认输</button>' +
        '</div>'
      );
      $('m-resign-black').addEventListener('click', function () {
        close2(); finishResign(E.BLACK);
      });
      $('m-resign-white').addEventListener('click', function () {
        close2(); finishResign(E.WHITE);
      });
      return;
    }
    var close = openModal(
      '<div class="modal-title">确认认输</div>' +
      '<div class="modal-body">确定认输本局吗？</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>取消</button>' +
      '<button class="btn primary" id="m-resign-yes">认输</button>' +
      '</div>'
    );
    $('m-resign-yes').addEventListener('click', function () {
      close();
      if (state.net) state.net.send('resign', {});
    });
  }

  /** pvp 认输收尾：loser 判负，winner 获胜。 */
  function finishResign(loser) {
    var g = state.game;
    var winner = E.opp(loser);
    g.over = { winner: winner, line: null, reason: 'resign' };
    if (winner === E.BLACK) A.win(); else A.lose();
    showGameOver(g.over, winner === E.BLACK);
    saveHistory(g.over);
    refreshUI();
  }

  function doRestart() {
    if (state.mode === 'ai') {
      // 【2026-08-16】先关闭任何弹窗（三手交换选择窗等）——弹窗残留会挡住
      // 重开流程，AI 先手时新局卡"AI 思考中"（用户反馈"取消玩家先手后不落子"）
      $('modal-root').classList.add('hidden');
      startNewGame(true);
      state.aiStarted = true; // 重开沿用当前设置并保持锁定
      // AI 先手：新局首步由 AI 落子（此前只 startNewGame 导致死局）
      if (state.playerFirst) startTicker();
      else aiFirstMove();
      refreshUI();
      toast('已重新开局');
      return;
    }
    if (state.mode === 'pvp') {
      $('modal-root').classList.add('hidden');
      startNewGame(true);
      state.aiStarted = true; // 沿用当前设置并保持锁定
      state.swapDecided = false;
      state.swapped = false;
      startTicker();
      refreshUI();
      toast('已重新开局：黑先白后');
      return;
    }
    if (!state.net) return;
    var close = openModal(
      '<div class="modal-title">重新开局</div>' +
      '<div class="modal-body">请求与对方开始新的一局，需要对方同意。</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>取消</button>' +
      '<button class="btn primary" id="m-restart-yes">发送请求</button>' +
      '</div>'
    );
    $('m-restart-yes').addEventListener('click', function () {
      close();
      if (state.isHost) state.net.sendTo(state.mySeat === 'black' ? 'white' : 'black', 'restart-req', {});
      else state.net.send('restart-req', {});
      toast('已发送重开请求');
    });
  }

  // ─────────────────────────── 胜负弹窗 / 历史保存 ───────────────────────────

  function resultText(over) {
    if (!over) return { big: '对局结束', sub: '', win: false, draw: false };
    if (over.winner === 0) return { big: '平局', sub: '棋盘已满', win: false, draw: true };
    var w = over.winner === E.BLACK ? '黑方' : '白方';
    var sub;
    if (over.reason === 'resign') sub = '对方认输';
    else if (over.reason === 'timeout') sub = '对方超时未归';
    else sub = '五子连珠';
    return { big: w + ' 胜', sub: sub, win: true, draw: false };
  }

  function showGameOver(over, iWin, origin) {
    var t = resultText(over);
    var close = openModal(
      '<div class="win-banner">' +
      '<div class="big ' + (t.draw ? 'draw' : '') + '">' + t.big + '</div>' +
      '<div class="sub">' + t.sub + '</div>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>查看棋盘</button>' +
      '<button class="btn primary" data-again>再来一局</button>' +
      '</div>'
    );
    var again = $('modal-card').querySelector('[data-again]');
    if (again) {
      again.addEventListener('click', function () {
        close();
        if (state.mode === 'ai') {
          startNewGame(true);
          state.aiStarted = true; // 再来一局沿用当前设置并保持锁定
          // AI 先手：新局首步由 AI 落子（此前只 startNewGame 导致死局）
          if (state.playerFirst) startTicker();
          else aiFirstMove();
          refreshUI();
        }
        else if (state.mode === 'pvp') {
          startNewGame(true);
          state.aiStarted = true;
          state.swapDecided = false;
          state.swapped = false;
          startTicker();
          refreshUI();
        }
        else if (state.net) { doRestart(); }
      });
    }
    drawBoard();
  }

  function modeLabel() {
    if (state.mode === 'ai') return '人机对战';
    if (state.mode === 'pvp') return '本地双人';
    if (state.mode === 'lan') return '局域网联机';
    if (state.mode === 'online') return '互联网联机';
    return '';
  }

  function saveHistory(over, origin) {
    if (!over) return;
    var record = {
      id: Date.now(),
      mode: state.mode,
      level: state.mode === 'ai' ? state.aiLevel : null,
      players: {
        black: seatName('black'),
        white: state.mode === 'ai' ? seatName('white') : seatName('white')
      },
      result: over.winner === 0 ? 'draw' : (over.winner === E.BLACK ? 'black' : 'white'),
      winnerName: over.winner === 0 ? '' : seatName(over.winner === E.BLACK ? 'black' : 'white'),
      moves: state.game.moves.slice(),
      createdAt: new Date().toISOString(),
      durationMs: (state.timers.black + state.timers.white) * 1000
    };
    Store.add(record);
  }

  // ─────────────────────────── 聊天 ───────────────────────────

  function appendChat(from, text, isMine) {
    var log = $('chat-log');
    var d = document.createElement('div');
    d.className = 'chat-msg';
    var when = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    d.innerHTML = '<span class="who ' + (isMine ? 'me' : '') + '">' + esc(from) + '</span>' +
                  esc(text) + '<span class="when">' + when + '</span>';
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function appendSys(text) {
    var log = $('chat-log');
    var d = document.createElement('div');
    d.className = 'chat-msg sys';
    d.textContent = text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  $('chat-form').addEventListener('submit', function (ev) {
    ev.preventDefault();
    var input = $('chat-input');
    var text = input.value.trim();
    if (!text) return;
    input.value = '';
    if (state.mode === 'ai') { appendChat('你', text, true); return; }
    if (!state.net) { toast('尚未连接'); return; }
    // 联机：不本地渲染，由消息回路统一显示（host 收到后广播回所有端）
    state.net.send('chat', { from: state.myName, text: text });
  });

  // ─────────────────────────── 历史记录 ───────────────────────────

  function renderHistory() {
    var list = Store.loadAll();
    var box = $('history-list');
    if (!list.length) {
      box.innerHTML = '<div class="history-empty">暂无对局记录</div>';
      updateSelectedBar();
      return;
    }
    box.innerHTML = '';
    list.forEach(function (r) {
      var el = document.createElement('div');
      el.className = 'history-item';
      // 多选 checkbox（阻止冒泡避免触发回放）
      var cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'history-check';
      cb.checked = !!historySelected[r.id];
      cb.addEventListener('click', function (ev) {
        ev.stopPropagation();
        if (cb.checked) historySelected[r.id] = true;
        else delete historySelected[r.id];
        updateSelectedBar();
      });
      el.appendChild(cb);

      var result = '';
      if (r.result === 'draw') result = '<span class="result draw">平局</span>';
      else if (r.result === 'black') result = '<span class="result ' + (r.mode === 'ai' && r.result === 'white' ? 'lose' : (r.result === 'black' ? 'win' : 'lose')) + '">黑胜</span>';
      else result = '<span class="result ' + (r.result === 'white' ? 'win' : 'lose') + '">白胜</span>';
      var winCls = 'win', loseCls = 'lose';
      if (r.mode === 'ai') {
        result = r.result === 'draw'
          ? '<span class="result draw">平局</span>'
          : '<span class="result ' + (r.result === 'black' ? winCls : loseCls) + '">' + (r.result === 'black' ? '你胜' : '你负') + '</span>';
      } else {
        result = r.result === 'draw'
          ? '<span class="result draw">平局</span>'
          : '<span class="result ' + (r.result === 'black' ? winCls : loseCls) + '">黑胜</span>';
      }
      var time = new Date(r.createdAt).toLocaleString('zh-CN', { hour12: false });
      var modeName = r.mode === 'ai' ? '人机 · ' + (r.level || '') + ' 段' : (r.mode === 'lan' ? '局域网' : '互联网');
      var body = document.createElement('div');
      body.className = 'history-item-body';
      body.innerHTML =
        result +
        '<div class="meta">' +
        '<div class="row1">' + esc(modeName) + ' · ' + esc((r.players && r.players.black) || '黑方') + ' vs ' + esc((r.players && r.players.white) || '白方') + '</div>' +
        '<div>' + time + '</div>' +
        '</div>' +
        '<span class="moves-count">' + r.moves.length + ' 手</span>';
      body.addEventListener('click', function () { openReplay(r); });
      el.appendChild(body);

      // 单条导出按钮（阻止冒泡）
      var exp = document.createElement('button');
      exp.className = 'btn ghost sm history-export';
      exp.textContent = '导出';
      exp.title = '导出这条记录';
      exp.addEventListener('click', function (ev) {
        ev.stopPropagation();
        exportRecords([r], 'json');
      });
      el.appendChild(exp);

      box.appendChild(el);
    });
    updateSelectedBar();
  }

  /** 更新「导出选中」按钮的可用状态与数量提示。 */
  function updateSelectedBar() {
    var ids = Object.keys(historySelected).filter(function (k) { return historySelected[k]; });
    var n = ids.length;
    var j = $('btn-history-export-selected-json');
    var c = $('btn-history-export-selected-csv');
    if (j) { j.disabled = n === 0; j.textContent = n > 0 ? '导出选中 JSON (' + n + ')' : '导出选中 JSON'; }
    if (c) { c.disabled = n === 0; c.textContent = n > 0 ? '导出选中 CSV (' + n + ')' : '导出选中 CSV'; }
  }

  /** 按 id 集合导出记录（单条或多条）。 */
  function exportRecords(records, fmt) {
    if (!records.length) { toast('未选择记录'); return; }
    var ts = new Date().toISOString().slice(0, 10);
    if (fmt === 'json') {
      exportJSON(records.length === 1 ? records[0] : records, 'gomoku-history-' + ts + '.json');
    } else {
      var lines = ['id,mode,level,black,white,result,moves,created_at'];
      for (var i = 0; i < records.length; i++) {
        var r = records[i];
        lines.push([r.id, r.mode, r.level || '', (r.players && r.players.black) || '', (r.players && r.players.white) || '', r.result, r.moves.length, r.createdAt].join(','));
      }
      var csv = '\uFEFF' + lines.join('\n');
      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = (records.length === 1 ? 'gomoku-game' : 'gomoku-history') + '-' + ts + '.csv'; a.click();
      URL.revokeObjectURL(url);
    }
    toast('已导出 ' + records.length + ' 条记录 (' + fmt.toUpperCase() + ')');
  }

  /** 导出当前勾选的记录。 */
  function doExportSelected(fmt) {
    var ids = Object.keys(historySelected).filter(function (k) { return historySelected[k]; });
    if (!ids.length) { toast('请先勾选要导出的记录'); return; }
    var list = Store.loadAll();
    var recs = list.filter(function (r) { return historySelected[r.id]; });
    exportRecords(recs, fmt);
  }

  /** 回放弹窗：复用棋盘渲染，支持步进。 */
  function openReplay(record) {
    var replayGame = new E.Game();
    var step = 0;
    var playing = null;

    var close = openModal(
      '<div class="modal-title">对局回放</div>' +
      '<div class="modal-body" style="padding:0 0 12px;">' +
      '<div style="position:relative;width:100%;aspect-ratio:1;border-radius:8px;overflow:hidden;background:#e9e2d2;">' +
      '<canvas id="replay-board" style="width:100%;height:100%;display:block;"></canvas>' +
      '</div>' +
      '<div style="display:flex;align-items:center;gap:8px;margin-top:12px;">' +
      '<button class="btn outline sm" id="rp-prev">上一步</button>' +
      '<button class="btn primary sm" id="rp-play">播放</button>' +
      '<button class="btn outline sm" id="rp-next">下一步</button>' +
      '<span style="margin-left:auto;font-family:var(--mono);font-size:13px;color:var(--text-dim);" id="rp-count">0 / ' + record.moves.length + '</span>' +
      '</div>' +
      '<div id="rp-list" class="rp-list"></div>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>关闭</button>' +
      '</div>'
    );

    var rp = document.getElementById('replay-board');
    var rpCtx = rp.getContext('2d');

    function rpSize() {
      var w = rp.parentElement.clientWidth;
      rp.width = w; rp.height = w;
      return w;
    }

    function rpDraw() {
      var w = rpSize();
      var c = w / (SIZE + 1);
      rpCtx.fillStyle = '#e9e2d2';
      rpCtx.fillRect(0, 0, w, w);
      rpCtx.strokeStyle = '#5b5342';
      rpCtx.lineWidth = 1;
      for (var i = 0; i < SIZE; i++) {
        var p = c * (i + 1);
        rpCtx.beginPath();
        rpCtx.moveTo(c, p); rpCtx.lineTo(w - c, p);
        rpCtx.moveTo(p, c); rpCtx.lineTo(p, w - c);
        rpCtx.stroke();
      }
      rpCtx.fillStyle = '#5b5342';
      [[7, 7], [3, 3], [11, 3], [3, 11], [11, 11]].forEach(function (s) {
        rpCtx.beginPath();
        rpCtx.arc(c * (s[0] + 1), c * (s[1] + 1), 3, 0, Math.PI * 2);
        rpCtx.fill();
      });
      var g = replayGame;
      for (var y = 0; y < SIZE; y++) {
        for (var x = 0; x < SIZE; x++) {
          var v = E.get(g.board, x, y);
          if (!v) continue;
          rpCtx.beginPath();
          rpCtx.arc(c * (x + 1), c * (y + 1), c * 0.42, 0, Math.PI * 2);
          rpCtx.fillStyle = v === E.BLACK ? '#14161a' : '#f2f0ea';
          rpCtx.fill();
          rpCtx.strokeStyle = v === E.BLACK ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.3)';
          rpCtx.stroke();
        }
      }
      // 步数标注：棋盘上每个棋子旁标手数（与主棋盘一致）
      var rpMoves = replayGame.moves;
      rpCtx.textAlign = 'center';
      rpCtx.textBaseline = 'middle';
      for (var mi2 = 0; mi2 < rpMoves.length; mi2++) {
        var rm = rpMoves[mi2];
        rpCtx.fillStyle = rm.player === E.BLACK ? '#d4a853' : '#5b5342';
        rpCtx.font = 'bold ' + (c * 0.34) + 'px ' + getComputedStyle(document.documentElement).getPropertyValue('--mono').split(',')[0].trim();
        rpCtx.fillText(mi2 + 1, c * (rm.x + 1), c * (rm.y + 1));
      }
      if (step > 0) {
        var m = record.moves[step - 1];
        rpCtx.strokeStyle = '#d4a853';
        rpCtx.lineWidth = 2;
        rpCtx.beginPath();
        rpCtx.arc(c * (m.x + 1), c * (m.y + 1), c * 0.34, 0, Math.PI * 2);
        rpCtx.stroke();
      }
      document.getElementById('rp-count').textContent = step + ' / ' + record.moves.length;
      renderRpList();
    }

    /** 棋谱列表：每行「第 N 手 · ●黑/○白 · 坐标」，当前步高亮，点击跳转。 */
    function renderRpList() {
      var box = document.getElementById('rp-list');
      if (!box) return;
      var html = '';
      for (var i = 0; i < record.moves.length; i++) {
        var mv = record.moves[i];
        var p = mv.player === E.BLACK ? '黑' : '白';
        var dot = mv.player === E.BLACK ? '●' : '○';
        var coord = String.fromCharCode(65 + mv.x) + (mv.y + 1);
        var cur = (i + 1 === step) ? ' class="cur"' : '';
        html += '<div data-n="' + (i + 1) + '"' + cur + '>' +
          '<span class="n">' + (i + 1) + '</span>' +
          '<span class="d">' + dot + p + '</span>' +
          '<span class="c">' + coord + '</span>' +
          '</div>';
      }
      box.innerHTML = html;
      // 当前步滚动到可见区
      var curEl = box.querySelector('.cur');
      if (curEl) curEl.scrollIntoView({ block: 'nearest' });
    }

    function rpGo(n) {
      step = Math.max(0, Math.min(record.moves.length, n));
      replayGame = new E.Game();
      for (var i = 0; i < step; i++) {
        var m = record.moves[i];
        replayGame.play(m.x, m.y);
      }
      rpDraw();
      var endBtn = document.getElementById('rp-play');
      if (step >= record.moves.length && playing) { stopPlay(); }
      return step;
    }

    function stopPlay() {
      if (playing) { clearInterval(playing); playing = null; }
      var b = document.getElementById('rp-play');
      if (b) b.textContent = '播放';
    }

    document.getElementById('rp-prev').addEventListener('click', function () { stopPlay(); rpGo(step - 1); });
    document.getElementById('rp-next').addEventListener('click', function () { stopPlay(); rpGo(step + 1); });
    // 棋谱列表点击跳转
    document.getElementById('rp-list').addEventListener('click', function (ev) {
      var item = ev.target.closest('[data-n]');
      if (!item) return;
      stopPlay();
      rpGo(parseInt(item.getAttribute('data-n'), 10));
    });
    document.getElementById('rp-play').addEventListener('click', function () {
      if (playing) { stopPlay(); return; }
      if (step >= record.moves.length) rpGo(0);
      this.textContent = '暂停';
      playing = setInterval(function () {
        if (rpGo(step + 1) >= record.moves.length) stopPlay();
      }, 450);
    });

    rpDraw();
    // 弹窗出现后再量一次尺寸（布局稳定后）
    setTimeout(rpDraw, 50);
  }

  // ─────────────────────────── 事件绑定 ───────────────────────────

  // 棋盘点击（canvas 坐标 → 网格交点，就近取整）
  board.addEventListener('click', function (ev) {
    A.unlock();
    // 对局已结束：明确提示，避免"点了没反应"误以为卡死
    if (state.game.over) {
      toast('对局已结束，点击「重开」或「再来一局」开始新对局');
      return;
    }
    var rect = board.getBoundingClientRect();
    var c = rect.width / (SIZE + 1);
    var x = Math.round((ev.clientX - rect.left) / c) - 1;
    var y = Math.round((ev.clientY - rect.top) / c) - 1;
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) return;
    doMove(x, y);
  });

  // 鼠标移动 → 准星
  board.addEventListener('mousemove', function (ev) {
    var rect = board.getBoundingClientRect();
    var c = rect.width / (SIZE + 1);
    var x = Math.round((ev.clientX - rect.left) / c) - 1;
    var y = Math.round((ev.clientY - rect.top) / c) - 1;
    if (x < 0 || x >= SIZE || y < 0 || y >= SIZE) {
      if (mouseCell) { mouseCell = null; drawBoard(); }
      return;
    }
    if (mouseCell && mouseCell.x === x && mouseCell.y === y) return;
    mouseCell = { x: x, y: y };
    drawBoard();
  });
  board.addEventListener('mouseleave', function () {
    if (mouseCell) { mouseCell = null; drawBoard(); }
  });

  // 触屏也支持点击（click 事件在移动端已覆盖）

  $('btn-home').addEventListener('click', goHome);
  $('btn-open-history').addEventListener('click', function () { showView('history'); });

  // 首页：进入对局界面（开关/开始对局按钮在对局界面内，确认后再开局）
  $('btn-enter-ai').addEventListener('click', function () {
    enterAIGame(state.aiLevel);
  });
  // 本地双人：进入对局界面，黑先白后
  $('btn-enter-pvp').addEventListener('click', function () {
    enterPvpGame();
  });
  $('btn-lan-create').addEventListener('click', function () {
    if (!state.peerAvailable) { toast('PeerJS 加载失败，联机不可用（可能离线）'); return; }
    askNameAndCreate('lan');
  });
  $('btn-lan-join').addEventListener('click', function () {
    if (!state.peerAvailable) { toast('PeerJS 加载失败，联机不可用（可能离线）'); return; }
    askCodeAndJoin('lan');
  });
  $('btn-online-create').addEventListener('click', function () {
    if (!state.peerAvailable) { toast('PeerJS 加载失败，联机不可用（可能离线）'); return; }
    askNameAndCreate('online');
  });
  $('btn-online-join').addEventListener('click', function () {
    if (!state.peerAvailable) { toast('PeerJS 加载失败，联机不可用（可能离线）'); return; }
    askCodeAndJoin('online');
  });

  // 段位选择（对局界面开局设置区内：与先手/禁手/三手交换开关并列）
  var levelBtns = document.querySelectorAll('.ai-setup .level-btn');
  levelBtns.forEach(function (btn) {
    btn.addEventListener('click', function () {
      state.aiLevel = parseInt(btn.dataset.level, 10);
      levelBtns.forEach(function (b) { b.classList.toggle('active', b === btn); });
    });
  });
  // 默认选中 4 段
  document.querySelector('.ai-setup .level-btn[data-level="4"]').classList.add('active');

  // ─────────────────────────── AlphaZero 引擎 ───────────────────────────

  // 每局结束自动导出棋谱（供 ai/learn.py 复盘学习 → 模型进化）
  function exportReplayForLearning() {
    if (state.mode !== 'ai') return;
    var g = state.game;
    if (!g.moves || g.moves.length < 4) return;
    var ts = new Date().toISOString().replace(/[:.]/g, '-');
    var data = {
      mode: 'ai',
      level: state.aiLevel,
      engine: 'fusion',
      winner: g.over ? (g.over.winner === E.BLACK ? 'black' : g.over.winner === E.WHITE ? 'white' : 'draw') : 'ongoing',
      moves: g.moves.map(function (m) {
        return { x: m.x, y: m.y, player: m.player === E.BLACK ? 'black' : 'white' };
      })
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'gomoku-game-' + ts + '.json';
    a.click();
    URL.revokeObjectURL(url);
    toast('本局棋谱已导出 → 自动训练进程将接手学习（node ai/auto_learn.js）');
  }

  // AI 引擎融合：AlphaZero 模型注册进单一引擎（候选池融合；模型缺失引擎行为与原九段一致）
  if (window.NetForward && window.GOMOKU_MODEL) {
    var nf = new window.NetForward();
    try {
      nf.weights = window.GOMOKU_MODEL;
      nf._flatten();
      nf.loaded = true;
      AI._useNet(nf);
      var st = $('engine-status');
      if (st) st.textContent = '自学习模型已加载 ✓';
    } catch (e) {
      var st2 = $('engine-status');
      if (st2) st2.textContent = '';
    }
  }

  function askNameAndCreate(mode) {
    var close = openModal(
      '<div class="modal-title">创建房间</div>' +
      '<div class="modal-field"><label>你的昵称</label>' +
      '<input id="m-name" type="text" maxlength="12" placeholder="房主" autocomplete="off" spellcheck="false" name="nickname"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>取消</button>' +
      '<button class="btn primary" id="m-create-ok">创建</button>' +
      '</div>'
    );
    var input = $('m-name');
    input.value = '房主';
    input.focus();
    $('m-create-ok').addEventListener('click', function () {
      var name = input.value.trim() || '房主';
      close();
      createRoom(mode, name);
    });
  }

  function askCodeAndJoin(mode) {
    var close = openModal(
      '<div class="modal-title">加入房间</div>' +
      '<div class="modal-field"><label>房间码</label>' +
      '<input id="m-code" class="code-input" type="text" maxlength="4" placeholder="4 位房间码" autocomplete="off" spellcheck="false" name="room-code"></div>' +
      '<div class="modal-field"><label>你的昵称</label>' +
      '<input id="m-name2" type="text" maxlength="12" placeholder="玩家" autocomplete="off" spellcheck="false" name="nickname"></div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>取消</button>' +
      '<button class="btn primary" id="m-join-ok">加入</button>' +
      '</div>'
    );
    var code = $('m-code'), name = $('m-name2');
    code.value = ''; name.value = '玩家';
    code.focus();
    $('m-join-ok').addEventListener('click', function () {
      var c = code.value.trim().toUpperCase();
      if (c.length !== 4) { toast('请输入 4 位房间码'); return; }
      close();
      joinRoom(mode, c, name.value.trim() || '玩家');
    });
  }

  // 对局操作
  $('btn-undo').addEventListener('click', doUndo);
  $('btn-resign').addEventListener('click', doResign);
  $('btn-restart').addEventListener('click', doRestart);
  $('btn-leave').addEventListener('click', function () {
    if (state.net) { try { state.net.close(); } catch (e) { /* ignore */ } state.net = null; }
    goHome();
  });

  // ─────────────────────────── 沉浸式 HUD 事件 ───────────────────────────

  $('btn-hud-leave').addEventListener('click', function () {
    if (state.net) { try { state.net.close(); } catch (e) { /* ignore */ } state.net = null; }
    goHome();
  });
  $('btn-hud-undo').addEventListener('click', doUndo);
  $('btn-hud-resign').addEventListener('click', doResign);
  $('btn-hud-restart').addEventListener('click', doRestart);

  /** ⋯ 菜单：缩放 / 导出 / 返回大厅（补全沉浸态被隐藏的侧栏功能） */
  function openHudMenu() {
    var close = openModal(
      '<div class="modal-title">对局菜单</div>' +
      '<div class="modal-body" style="margin-bottom:8px;">棋盘缩放</div>' +
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:16px;">' +
      '<button class="btn outline" id="m-zoom-out">−</button>' +
      '<span id="m-zoom-label" style="flex:1;text-align:center;font-family:var(--mono);font-size:15px;color:var(--text);">' + Math.round(zoomLevel * 100) + '%</span>' +
      '<button class="btn outline" id="m-zoom-in">＋</button>' +
      '<button class="btn outline" id="m-zoom-reset">重置</button>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" id="m-export-json">导出 JSON</button>' +
      '<button class="btn outline" id="m-export-csv">导出 CSV</button>' +
      '</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>关闭</button>' +
      '<button class="btn primary" id="m-leave">返回大厅</button>' +
      '</div>'
    );
    $('m-zoom-in').addEventListener('click', function () { setBoardZoom(zoomLevel + 0.25); });
    $('m-zoom-out').addEventListener('click', function () { setBoardZoom(zoomLevel - 0.25); });
    $('m-zoom-reset').addEventListener('click', function () { setBoardZoom(1); });
    $('m-export-json').addEventListener('click', doExportCurrentJSON);
    $('m-export-csv').addEventListener('click', doExportCurrentCSV);
    $('m-leave').addEventListener('click', function () { close(); goHome(); });
  }
  $('btn-hud-menu').addEventListener('click', openHudMenu);

  // 沉浸态：滚轮 / 双指捏合缩放棋盘（普通态保留按钮缩放）
  var scrollEl = document.querySelector('.board-scroll');
  var pinchDist = 0;
  var pinchTouches = null;
  scrollEl.addEventListener('wheel', function (ev) {
    if (!document.body.classList.contains('immersive')) return;
    ev.preventDefault();
    var f = ev.deltaY < 0 ? 1.08 : 0.925;
    setBoardZoom(zoomLevel * f);
  }, { passive: false });
  scrollEl.addEventListener('touchstart', function (ev) {
    if (!document.body.classList.contains('immersive')) return;
    if (ev.touches.length === 2) {
      pinchTouches = ev.touches;
      pinchDist = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX,
                             ev.touches[0].clientY - ev.touches[1].clientY);
    } else if (ev.touches.length < 2) { pinchTouches = null; }
  }, { passive: true });
  scrollEl.addEventListener('touchmove', function (ev) {
    if (!document.body.classList.contains('immersive')) return;
    if (ev.touches.length === 2 && pinchTouches) {
      var d = Math.hypot(ev.touches[0].clientX - ev.touches[1].clientX,
                         ev.touches[0].clientY - ev.touches[1].clientY);
      if (pinchDist > 0) setBoardZoom(zoomLevel * (d / pinchDist));
      pinchDist = d;
    }
  }, { passive: true });
  scrollEl.addEventListener('touchend', function () { pinchTouches = null; }, { passive: true });

  $('btn-history-clear').addEventListener('click', function () {
    if (Store.loadAll().length === 0) return;
    var close = openModal(
      '<div class="modal-title">清空记录</div>' +
      '<div class="modal-body">确定删除全部对局记录吗？此操作不可恢复。</div>' +
      '<div class="modal-actions">' +
      '<button class="btn outline" data-dismiss>取消</button>' +
      '<button class="btn primary" id="m-clear-ok">清空</button>' +
      '</div>'
    );
    $('m-clear-ok').addEventListener('click', function () {
      Store.clear();
      historySelected = {};
      close();
      renderHistory();
      toast('已清空对局记录');
    });
  });

  // 导出按钮
  $('btn-export-json').addEventListener('click', doExportCurrentJSON);
  $('btn-export-csv').addEventListener('click', doExportCurrentCSV);
  $('btn-history-export-json').addEventListener('click', doExportHistoryJSON);
  $('btn-history-export-csv').addEventListener('click', doExportHistoryCSV);
  $('btn-history-export-selected-json').addEventListener('click', function () { doExportSelected('json'); });
  $('btn-history-export-selected-csv').addEventListener('click', function () { doExportSelected('csv'); });
  $('btn-history-back').addEventListener('click', function () { showView('home'); });

  // 先手/禁手/三手交换开关（对局界面开局设置区：开局前可调，落子后锁定）
  // 【2026-08-16 重构】开关与「开始对局」按钮同在对局界面，确认好选项再开局；
  // 对局中（aiStarted && !over）锁定，对局结束解锁可改设置再开新局。
  $('toggle-first').addEventListener('change', function () {
    if ((state.mode === 'ai' || state.mode === 'pvp') && state.aiStarted && !state.game.over) {
      this.checked = !this.checked; // 防御：disabled 已挡住 UI 操作
      toast('对局已开始，设置已锁定');
      return;
    }
    state.playerFirst = this.checked;
    state.mySeat = state.playerFirst ? 'black' : 'white';
    renderPlayers(null);
    toast(this.checked ? '已切换为玩家先手（黑棋）' : '已切换为 AI 先手（黑棋）');
  });
  $('toggle-forbid').addEventListener('change', function () {
    if ((state.mode === 'ai' || state.mode === 'pvp') && state.aiStarted && !state.game.over) {
      this.checked = !this.checked;
      toast('对局已开始，设置已锁定');
      return;
    }
    state.forbidEnabled = this.checked;
    toast(this.checked ? '黑棋禁手已开启（三三/四四/长连禁手）' : '黑棋禁手已关闭（无禁手规则）');
  });
  $('toggle-swap').addEventListener('change', function () {
    if ((state.mode === 'ai' || state.mode === 'pvp') && state.aiStarted && !state.game.over) {
      this.checked = !this.checked;
      toast('对局已开始，设置已锁定');
      return;
    }
    state.swapEnabled = this.checked;
    toast(this.checked ? '三手交换已开启（黑 1 天元，前三手后白方可换边）' : '三手交换已关闭');
  });

  // 对局界面「开始对局」按钮：真正开局（moves>0 时按钮禁用，结束后可再开局）
  $('btn-start-ai').addEventListener('click', function () {
    if (state.mode === 'pvp') { beginPvpGame(); return; }
    beginAIGame();
  });

  // 棋盘缩放
  $('btn-zoom-in').addEventListener('click', function () { setBoardZoom(zoomLevel + 0.25); });
  $('btn-zoom-out').addEventListener('click', function () { setBoardZoom(zoomLevel - 0.25); });
  $('btn-zoom-reset').addEventListener('click', function () { setBoardZoom(1); });

  // 窗口尺寸变化 → 重绘棋盘
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(function () {
      if (state.view === 'game') resizeBoard();
    }, 150);
  });

  // 首次交互解锁音频
  document.addEventListener('pointerdown', function once() {
    A.unlock();
    document.removeEventListener('pointerdown', once);
  });

  // ─────────────────────────── 启动 ───────────────────────────

  if (!state.peerAvailable) {
    toast('PeerJS 加载失败：联机模式不可用，人机对战不受影响');
  }
  showView('home');
  resizeBoard();
})();
