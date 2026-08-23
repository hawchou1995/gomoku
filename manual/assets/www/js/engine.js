/**
 * engine.js — 五子棋核心规则引擎（纯逻辑，无 DOM 依赖）
 *
 * 棋盘为 15×15 的 Uint8Array：0=空、1=黑、2=白
 * 同时兼容浏览器（window.GomokuEngine）与 Node（module.exports）环境，
 * 便于本地做规则/AI 单测。
 */
(function (global) {
  'use strict';

  var SIZE = 15;
  var EMPTY = 0, BLACK = 1, WHITE = 2;

  function idx(x, y) { return y * SIZE + x; }
  function inB(x, y) { return x >= 0 && x < SIZE && y >= 0 && y < SIZE; }
  function get(b, x, y) { return b[idx(x, y)]; }
  function set(b, x, y, p) { b[idx(x, y)] = p; }
  function opp(p) { return p === BLACK ? WHITE : BLACK; }

  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  /**
   * 单方向形状分析（含跳形）——与 ai.js shapeInfo 语义严格一致，
   * 保证引擎禁手判定与 AI 威胁认知（classifyPoint）对齐。
   * 返回 { count, jumpL, jumpR, openL, openR, jumpOpenL, jumpOpenR }
   *   count: 连续段长（含落点）
   *   jumpL/jumpR: 连续段外侧隔一空后的跳段子数（左/右）
   *   openL/openR: 连续段两端是否开放（紧邻为空）
   *   jumpOpenL/jumpOpenR: 跳段外端是否开放
   */
  function lineShape(board, x, y, player, dx, dy) {
    var count = 1;
    var openL = 0, openR = 0, jumpL = 0, jumpR = 0, jumpOpenL = 0, jumpOpenR = 0;
    var nx = x + dx, ny = y + dy;
    while (inB(nx, ny) && get(board, nx, ny) === player) { count++; nx += dx; ny += dy; }
    if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
      openR = 1;
      var gx = nx + dx, gy = ny + dy;
      while (inB(gx, gy) && get(board, gx, gy) === player) { jumpR++; gx += dx; gy += dy; }
      if (inB(gx, gy) && get(board, gx, gy) === EMPTY) jumpOpenR = 1;
    }
    nx = x - dx; ny = y - dy;
    while (inB(nx, ny) && get(board, nx, ny) === player) { count++; nx -= dx; ny -= dy; }
    if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
      openL = 1;
      gx = nx - dx; gy = ny - dy;
      while (inB(gx, gy) && get(board, gx, gy) === player) { jumpL++; gx -= dx; gy -= dy; }
      if (inB(gx, gy) && get(board, gx, gy) === EMPTY) jumpOpenL = 1;
    }
    return { count: count, jumpL: jumpL, jumpR: jumpR, openL: openL, openR: openR, jumpOpenL: jumpOpenL, jumpOpenR: jumpOpenR };
  }

  function createBoard() { return new Uint8Array(SIZE * SIZE); }

  /**
   * 以 (x,y) 为端点检查四方向连珠。
   * 命中返回 { player, line:[{x,y}×5] }，否则返回 null。
   */
  function checkWin(board, x, y) {
    var p = get(board, x, y);
    if (p === EMPTY) return null;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var line = [{ x: x, y: y }];
      for (var s = 1; s < 5; s++) {
        var nx = x + dx * s, ny = y + dy * s;
        if (inB(nx, ny) && get(board, nx, ny) === p) line.push({ x: nx, y: ny });
        else break;
      }
      for (s = 1; s < 5; s++) {
        nx = x - dx * s; ny = y - dy * s;
        if (inB(nx, ny) && get(board, nx, ny) === p) line.unshift({ x: nx, y: ny });
        else break;
      }
      if (line.length >= 5) return { player: p, line: line.slice(0, 5) };
    }
    return null;
  }

  /**
   * 对局状态机。moves 为落子序列（悔棋/回放/历史都靠它）。
   */
  function Game() {
    this.reset();
  }

  Game.prototype.reset = function () {
    this.board = createBoard();
    this.turn = BLACK;
    this.moves = [];       // [{x,y,player}]
    this.over = null;      // null | {winner, line}  winner: 1|2|0(平局)
    this.seq = 0;          // 单调递增，用于联机消息去重/排序
    this.forbidEnabled = false; // 黑棋禁手开关
  };

  Game.prototype.isFull = function () {
    return this.moves.length >= SIZE * SIZE;
  };

  /**
   * 检查黑棋在 (x,y) 是否构成禁手。
   * 禁手规则（与 RIF/标准禁手对齐，语义与 ai.js classifyPoint 一致）：
   *   - 三三：≥2 个活三（含跳活三：X_XX / XX_X，补 gap 后须成活四，即双端开放）
   *   - 四四：≥2 个活四/冲四（含跳四：补 gap 即成五连）
   *   - 长连：≥6 子连珠
   *   - 黑五连（恰好 5 子）不算禁手，且五连优先于三三/四四
   * 返回 null（无禁手）或禁手类型字符串（'长连' / '三三' / '四四' 或其组合）。
   */
  Game.prototype.checkForbid = function (x, y) {
    if (!this.forbidEnabled) return null;
    if (this.turn !== BLACK) return null;
    if (get(this.board, x, y) !== EMPTY) return null;

    // 临时落子
    set(this.board, x, y, BLACK);
    var result = null;

    var live3 = 0, four = 0;   // four = 活四 + 冲四
    var overline = false, five = false;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var s = lineShape(this.board, x, y, BLACK, dx, dy);
      if (s.count >= 6) { overline = true; continue; }      // 长连
      if (s.count === 5) { five = true; continue; }         // 恰五连：黑胜优先，不判禁手
      var jumpTotal = s.jumpL + s.jumpR;
      var total = s.count + jumpTotal;
      if (s.count === 4) {
        // 连续四连：双端开=活四；单端开=冲四；双端堵=死四（无威胁，不计）
        var openCnt4 = (s.openL ? 1 : 0) + (s.openR ? 1 : 0);
        if (openCnt4 >= 2) four++;
        else if (openCnt4 === 1) four++;
        continue;
      }
      // 两端开放度：跳侧取跳段外开放端，非跳侧取紧邻开放端（与 classifyPoint 同式）
      var open = 0;
      if (s.jumpL > 0) { if (s.jumpOpenL) open++; }
      else if (s.openL) open++;
      if (s.jumpR > 0) { if (s.jumpOpenR) open++; }
      else if (s.openR) open++;
      if (jumpTotal > 0) {
        // 跳形：total≥4 → 补 gap 成五 → 冲四级；total=3 且双端开放 → 活三
        if (total >= 4) four++;
        else if (total === 3 && open === 2) live3++;
      } else {
        // 纯连续段
        if (total === 4) { if (open >= 2) four++; else if (open === 1) four++; }
        else if (total === 3 && open === 2) live3++;
      }
    }

    if (overline) {
      result = '长连';
    } else if (five) {
      // 恰五连：黑胜优先，不构成禁手
      set(this.board, x, y, EMPTY);
      return null;
    }
    if (live3 >= 2) result = result ? result + '+三三' : '三三';
    if (four >= 2) result = result ? result + '+四四' : '四四';

    // 回滚
    set(this.board, x, y, EMPTY);
    return result;
  };

  /** 尝试落子。返回 {ok, over, forbid}；不合法返回 {ok:false}。 */
  Game.prototype.play = function (x, y) {
    if (this.over) return { ok: false, reason: 'over' };
    if (!inB(x, y) || get(this.board, x, y) !== EMPTY) return { ok: false, reason: 'occupied' };
    var forbid = this.checkForbid(x, y);
    if (forbid) return { ok: false, reason: 'forbid', forbid: forbid };
    set(this.board, x, y, this.turn);
    this.moves.push({ x: x, y: y, player: this.turn });
    this.seq++;
    var w = checkWin(this.board, x, y);
    if (w) {
      this.over = { winner: w.player, line: w.line };
      return { ok: true, over: this.over };
    }
    if (this.isFull()) {
      this.over = { winner: 0, line: null };
      return { ok: true, over: this.over };
    }
    this.turn = opp(this.turn);
    return { ok: true, over: null };
  };

  /** 撤回最后 n 步（默认 1）。返回被撤回的步数。 */
  Game.prototype.undo = function (n) {
    n = n || 1;
    var removed = 0;
    while (n-- > 0 && this.moves.length > 0) {
      var m = this.moves.pop();
      set(this.board, m.x, m.y, EMPTY);
      this.turn = m.player;
      this.over = null;
      removed++;
    }
    return removed;
  };

  /** 按历史序列重建棋盘（回放用）。 */
  Game.prototype.replayTo = function (count) {
    var g = new Game();
    for (var i = 0; i < Math.min(count, this.moves.length); i++) {
      var m = this.moves[i];
      g.play(m.x, m.y);
    }
    return g;
  };

  /** 序列化整局（用于历史记录/重连快照）。 */
  Game.prototype.toJSON = function () {
    return {
      moves: this.moves,
      turn: this.turn,
      over: this.over,
      seq: this.seq
    };
  };

  /** 从序列化数据恢复。 */
  Game.prototype.load = function (data) {
    this.reset();
    var i;
    for (i = 0; i < data.moves.length; i++) {
      var m = data.moves[i];
      set(this.board, m.x, m.y, m.player);
    }
    this.moves = data.moves.slice();
    this.turn = data.turn;
    this.over = data.over ? { winner: data.over.winner, line: data.over.line } : null;
    this.seq = data.seq || this.moves.length;
  };

  var api = {
    SIZE: SIZE, EMPTY: EMPTY, BLACK: BLACK, WHITE: WHITE,
    createBoard: createBoard, checkWin: checkWin, Game: Game,
    inB: inB, get: get, set: set, opp: opp
  };

  global.GomokuEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
