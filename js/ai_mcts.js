/**
 * AlphaZero 风格 MCTS（浏览器端）——与 ai/mcts.py 同构。
 * 依赖：js/net_forward.js（策略-价值网络前向）
 * 特征编码：8 平面（当前方最近 4 步 + 对手方最近 4 步），与 ai/game.py encode_state 一致
 * 用法：AiMcts.init(modelUrl, cb) → AiMcts.getBestMove(board, player, history, nPlayout)
 * 若模型加载失败自动返回 null（调用方回退启发式 AI）。
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) module.exports = factory(require('./net_forward.js'));
  else root.AiMcts = factory(root.NetForward);
})(typeof self !== 'undefined' ? self : this, function (NetForward) {
  'use strict';

  var SIZE = 15;
  var C_PUCT = 5.0;
  var DIRICHLET_ALPHA = 0.3;
  var DIRICHLET_WEIGHT = 0.25;
  var NOISE_FIRST_N = 12;

  var net = null;
  var loaded = false;

  function init(modelUrl, cb) {
    net = new NetForward();
    // file:// 环境下 fetch 会被 CORS 拦截 → 支持全局注入（model/best_net.js 定义 window.GOMOKU_MODEL）
    if (typeof window !== 'undefined' && window.GOMOKU_MODEL) {
      net.weights = window.GOMOKU_MODEL;
      try { net._flatten(); loaded = true; } catch (e) { loaded = false; }
      if (cb) cb(loaded ? null : new Error('model flatten failed'), loaded);
      return;
    }
    net.load(modelUrl, function (err) {
      loaded = !err;
      if (cb) cb(err, loaded);
    });
  }

  function isLoaded() { return loaded; }

  // ---------- 特征编码（与 Python encode_state 一致） ----------
  function encodeState(board, history, player) {
    var planes = new Float64Array(8 * SIZE * SIZE);
    var cur = [], opp = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if (m.player === player) cur.push(m);
      else opp.push(m);
    }
    var curLast = cur.slice(-4), oppLast = opp.slice(-4);
    for (var c = 0; c < curLast.length; c++) {
      var s = curLast[c];
      planes[c * SIZE * SIZE + s.y * SIZE + s.x] = 1.0;
    }
    for (var o = 0; o < oppLast.length; o++) {
      var t = oppLast[o];
      planes[(4 + o) * SIZE * SIZE + t.y * SIZE + t.x] = 1.0;
    }
    return planes;
  }

  // ---------- MCTS ----------
  function TreeNode(parent, prior) {
    this.parent = parent;
    this.prior = prior;
    this.children = {}; // "x,y" -> TreeNode
    this.nVisits = 0;
    this.totalValue = 0;
  }
  TreeNode.prototype.value = function () {
    return this.nVisits ? this.totalValue / this.nVisits : 0;
  };
  TreeNode.prototype.isExpanded = function () {
    return Object.keys(this.children).length > 0;
  };
  TreeNode.prototype.select = function () {
    var bestKey = null, bestNode = null, bestScore = -Infinity;
    for (var k in this.children) {
      var ch = this.children[k];
      var u = C_PUCT * ch.prior * Math.sqrt(this.nVisits) / (1 + ch.nVisits);
      var score = ch.value() + u;
      if (score > bestScore) { bestScore = score; bestKey = k; bestNode = ch; }
    }
    return [bestKey, bestNode];
  };
  TreeNode.prototype.updateRecursive = function (leafValue) {
    if (this.parent) this.parent.updateRecursive(-leafValue);
    this.nVisits++;
    this.totalValue += leafValue;
  };

  function MCTS() {
    this.root = null;
  }

  MCTS.prototype.playout = function (game) {
    // game: {board, history, current, winner, legal, place, isEnd}
    var node = this.root;
    var g = cloneGame(game);
    while (node.isExpanded && node.isExpanded() && !g.isEnd()) {
      var sel = node.select();
      var parts = sel[0].split(',');
      g.place(parseInt(parts[0], 10), parseInt(parts[1], 10));
      node = sel[1];
    }
    if (g.isEnd()) {
      var w = g.winner;
      // 叶节点视角 = 该走的人（g.current）。胜者==该走的人 → +1，否则 -1。
      // 【2026-08-16 修复】此前写反（-1:1）：黑胜分支被当白方好结果 →
      // MCTS 不防守五连成型点，棋谱20 白 8 弃 L12 防杀自走 B8/F8（Python 端正确，仅 JS 反）。
      var leafValue = w === 0 ? 0 : (w === g.current ? 1 : -1);
      node.updateRecursive(leafValue);
      return;
    }
    // 网络评估
    var planes = encodeState(g.board, g.history, g.current);
    var r = net.forward(planes);
    var legal = g.legal;
    // 合法点概率：网络 policy × 启发式棋形先验（ego 棋力注入）。
    // 网络弱时启发式主导（会下棋），网络强后 policy 自然占优。
    var legP = [];
    var sumP = 0;
    var heur = heuristicScores(g.board, g.current, legal);
    for (var a = 0; a < legal.length; a++) {
      var p0 = Math.max(r.policy[legal[a][1] * SIZE + legal[a][0]], 1e-8);
      var h0 = heur ? Math.max(heur[a], 1e-3) : 1;
      // 启发式主导（0.9）：ego 棋力立即可用；网络随自学习渐进增强（训练后调高网络权重）
      legP.push(Math.pow(p0, 0.1) * Math.pow(h0, 0.9));
      sumP += legP[a];
    }
    if (g.history.length < NOISE_FIRST_N) {
      var noise2 = dirichlet([DIRICHLET_ALPHA], legal.length);
      for (var b = 0; b < legP.length; b++) legP[b] = legP[b] / sumP * (1 - DIRICHLET_WEIGHT) + DIRICHLET_WEIGHT * noise2[b];
    } else {
      for (var b2 = 0; b2 < legP.length; b2++) legP[b2] /= sumP;
    }
    for (var c = 0; c < legal.length; c++) {
      node.children[legal[c][0] + ',' + legal[c][1]] = new TreeNode(node, legP[c]);
    }
    node.updateRecursive(r.value);
  };

  /**
   * 启发式棋形评分（复用 ai.js 的 classifyPoint）——ego 式棋力先验。
   * 返回与 legal 平行的评分数组；ai.js 不可用时返回 null（纯网络）。
   */
  var heuristicCache = null; // {board, player, scores}
  function heuristicScores(board, player, legal) {
    var AI = null;
    if (typeof require !== 'undefined') {
      try { require('./engine.js'); AI = require('./ai.js'); } catch (e) { AI = null; }
    }
    else if (typeof window !== 'undefined' && window.GomokuAI) AI = window.GomokuAI;
    if (!AI || !AI._classify) return null;
    var key = board + '|' + player;
    if (heuristicCache && heuristicCache.key === key && heuristicCache.board === board) return heuristicCache.scores;
    var scores = [];
    for (var i = 0; i < legal.length; i++) {
      var x = legal[i][0], y = legal[i][1];
      var mine = AI._classify(board, x, y, player);
      // 【2026-08-16 修复】engine 颜色编码 BLACK=1 / WHITE=2（非 ±1）——-player 会得到
      // 不存在的 -2，导致对手威胁检测全 0（棋谱20 白 8 弃 L12 防杀点自走 B8 的根因）
      var oppP = player === 1 ? 2 : 1;
      var opp = AI._classify(board, x, y, oppP);
      var s = 1;
      // 中心倾向（稀疏开局区分度来源：越靠近中心分越高）
      var dist = Math.abs(x - 7) + Math.abs(y - 7);
      s *= (1 + 2.5 / (1 + dist));
      if (mine.win > 0) s += 2000000;
      else if (mine.live4 > 0) s += 1000000;
      else if (mine.rush4 >= 2 || (mine.rush4 >= 1 && mine.live3 >= 1)) s += 500000;
      else if (mine.rush4 >= 1 || mine.live3 >= 1) s += 80000;
      else if (mine.sleep3 >= 1) s += 5000;
      else if (mine.live2 >= 1) s += 800;
      if (opp.win > 0) s += 1800000;
      else if (opp.live4 > 0) s += 900000;
      else if (opp.rush4 >= 2 || (opp.rush4 >= 1 && opp.live3 >= 1)) s += 450000;
      else if (opp.rush4 >= 1 || opp.live3 >= 1) s += 70000;
      else if (opp.sleep3 >= 1) s += 4000;
      scores.push(s);
    }
    heuristicCache = { key: key, board: board, scores: scores };
    return scores;
  }

  MCTS.prototype.getActionProbs = function (game, temp) {
    for (var i = 0; i < game.nPlayout; i++) this.playout(game);
    var acts = [], visits = [];
    for (var k in this.root.children) {
      acts.push(k);
      visits.push(this.root.children[k].nVisits);
    }
    if (temp < 1e-6) {
      var best = 0;
      for (var j = 1; j < visits.length; j++) if (visits[j] > visits[best]) best = j;
      var one = new Float64Array(acts.length);
      one[best] = 1;
      return [acts, one];
    }
    var maxV = -Infinity;
    for (var t = 0; t < visits.length; t++) if (visits[t] > maxV) maxV = visits[t];
    var exp = new Float64Array(visits.length), sumE = 0;
    for (var e = 0; e < visits.length; e++) { exp[e] = Math.exp(visits[e] / temp - maxV / temp); sumE += exp[e]; }
    for (var e2 = 0; e2 < exp.length; e2++) exp[e2] /= sumE;
    return [acts, exp];
  };

  // ---------- 游戏状态封装（复用 engine.js 常量语义） ----------
  function makeGame(board, player, history, nPlayout) {
    return {
      board: board,
      current: player,
      history: history,
      winner: 0,
      nPlayout: nPlayout || 100,
      legal: null,
      isEnd: function () {
        // 每次调用时刷新 legal
        this.legal = [];
        for (var y = 0; y < SIZE; y++) for (var x = 0; x < SIZE; x++) {
          if (this.board[y * SIZE + x] === 0) this.legal.push([x, y]);
        }
        return this.winner !== 0 || this.legal.length === 0;
      },
      place: function (x, y) {
        this.board[y * SIZE + x] = this.current;
        this.history.push({ x: x, y: y, player: this.current });
        if (this.checkWin(x, y)) this.winner = this.current;
        this.current = this.current === 1 ? 2 : 1; // engine 编码 BLACK=1/WHITE=2（非 ±1）
      },
      checkWin: function (x, y) {
        var dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
        var p = this.board[y * SIZE + x];
        for (var d = 0; d < 4; d++) {
          var cnt = 1;
          for (var s = 1; s < 5; s++) {
            var nx = x + dirs[d][0] * s, ny = y + dirs[d][1] * s;
            if (nx < 0 || nx >= SIZE || ny < 0 || ny >= SIZE || this.board[ny * SIZE + nx] !== p) break;
            cnt++;
          }
          for (var s2 = 1; s2 < 5; s2++) {
            var mx = x - dirs[d][0] * s2, my = y - dirs[d][1] * s2;
            if (mx < 0 || mx >= SIZE || my < 0 || my >= SIZE || this.board[my * SIZE + mx] !== p) break;
            cnt++;
          }
          if (cnt >= 5) return true;
        }
        return false;
      }
    };
  }

  function cloneGame(g) {
    var c = makeGame(new Int8Array(g.board), g.current, g.history.slice(), g.nPlayout);
    c.winner = g.winner;
    return c;
  }

  function dirichlet(alphaArr, n) {
    var out = new Float64Array(n);
    var sum = 0;
    var a = alphaArr[0];
    for (var i = 0; i < n; i++) {
      var x = sampleGamma(a, 1);
      out[i] = x;
      sum += x;
    }
    for (var j = 0; j < n; j++) out[j] /= sum;
    return out;
  }

  function sampleGamma(shape, scale) {
    // 支持 0 < shape < 1（Dirichlet alpha=0.3 需要）：shape+1 采样 × u^(1/shape) 校正
    if (shape < 1) {
      var u = Math.random();
      return sampleGamma(shape + 1, scale) * Math.pow(u, 1 / shape);
    }
    // Marsaglia-Tsang 方法（shape >= 1）
    var d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      var x = gaussian(), v = Math.pow(1 + c * x, 3);
      if (v <= 0) continue;
      var u2 = Math.random();
      if (u2 < 1 - 0.0331 * x * x * x * x) return d * v * scale;
      if (Math.log(u2) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v * scale;
    }
  }

  function gaussian() {
    var u = 0, v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /**
   * 获取最佳落子：返回 {x, y}，模型未加载返回 null。
   * board: Int8Array(225)（engine 布局 board[y*SIZE+x]，0/1/-1）
   * player: 1 黑 / -1 白
   * history: [{x, y, player}, ...]
   */
  function getBestMove(board, player, history, nPlayout) {
    if (!loaded || !net) return null;
    var game = makeGame(board, player, history.slice(), nPlayout || 100);
    var mcts = new MCTS();
    mcts.root = new TreeNode(null, 1);
    var acts, probs;
    try {
      var res = mcts.getActionProbs(game, 1e-3);
      acts = res[0]; probs = res[1];
    } catch (e) {
      return null;
    }
    var bestIdx = 0;
    for (var i = 1; i < probs.length; i++) if (probs[i] > probs[bestIdx]) bestIdx = i;
    var parts = acts[bestIdx].split(',');
    return { x: parseInt(parts[0], 10), y: parseInt(parts[1], 10) };
  }

  return {
    init: init,
    isLoaded: isLoaded,
    getBestMove: getBestMove,
    encodeState: encodeState,
    C_PUCT: C_PUCT,
    MCTS: MCTS,
    TreeNode: TreeNode
  };
});
