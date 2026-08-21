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
   * 禁手规则：三三、四四、长连（≥6子）。
   * 返回 null（无禁手）或禁手类型字符串。
   */
  Game.prototype.checkForbid = function (x, y) {
    if (!this.forbidEnabled) return null;
    if (this.turn !== BLACK) return null;
    if (get(this.board, x, y) !== EMPTY) return null;

    // 临时落子
    set(this.board, x, y, BLACK);
    var result = null;

    // 检查长连（≥6 子连珠，不计五连）
    var longCount = 0;
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var count = 1;
      var nx = x + dx, ny = y + dy;
      while (inB(nx, ny) && get(this.board, nx, ny) === BLACK) { count++; nx += dx; ny += dy; }
      nx = x - dx; ny = y - dy;
      while (inB(nx, ny) && get(this.board, nx, ny) === BLACK) { count++; nx -= dx; ny -= dy; }
      if (count >= 6) longCount++;
    }
    if (longCount > 0) { result = '长连'; }

    // 检查三三 / 四四
    var live3 = 0, live4 = 0;
    for (d = 0; d < 4; d++) {
      dx = DIRS[d][0]; dy = DIRS[d][1];
      // 数连子
      count = 1; var open = 0;
      nx = x + dx; ny = y + dy;
      while (inB(nx, ny) && get(this.board, nx, ny) === BLACK) { count++; nx += dx; ny += dy; }
      if (inB(nx, ny) && get(this.board, nx, ny) === EMPTY) open++;
      nx = x - dx; ny = y - dy;
      while (inB(nx, ny) && get(this.board, nx, ny) === BLACK) { count++; nx -= dx; ny -= dy; }
      if (inB(nx, ny) && get(this.board, nx, ny) === EMPTY) open++;
      if (count === 4 && open === 2) live4++;
      if (count === 3 && open === 2) live3++;
      // 冲四也算
      if (count === 4 && open === 1) live4++;
    }
    if (live3 >= 2) result = result ? result + '+三三' : '三三';
    if (live4 >= 2) result = result ? result + '+四四' : '四四';

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
