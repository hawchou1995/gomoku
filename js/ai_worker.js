/**
 * ai_worker.js — 五子棋 AI 搜索 Web Worker（2026-08-18）
 * 把重计算（九段 6.5s 迭代加深 / VCF-VCT 穷举）从主线程挪到 Worker，
 * 思考期间棋盘动画/点击不卡顿。
 *
 * 协议：
 *   onmessage 收到 { id, board(Array), player, level, ms, forbidEnabled, history }
 *   postMessage({ id, move: {x,y} | null })
 */
importScripts(
  'engine.js',
  'ai.js',
  'net_forward.js'
);

// model/best_net.js 定义 window.GOMOKU_MODEL —— Worker 里没有 window，shim 一下
self.window = self;
try { importScripts('../model/best_net.js'); } catch (e) { /* 模型缺失不致命，启发式引擎照跑 */ }

// 融合网络（可选）：注册到 GomokuAI，模型可用时 policy 融入候选池
try {
  if (self.GOMOKU_MODEL) {
    var nf = new self.NetForward();
    nf.weights = self.GOMOKU_MODEL;
    nf._flatten();
    nf.loaded = true;
    self.GomokuAI._useNet(nf);
  }
} catch (e) { /* 网络加载失败 → 纯启发式引擎 */ }

self.onmessage = function (ev) {
  var d = ev.data;
  try {
    var mv = self.GomokuAI.getBestMove(d.board, d.player, d.level, Date.now() + d.ms, d.forbidEnabled, d.history || []);
    self.postMessage({ id: d.id, move: mv });
  } catch (err) {
    self.postMessage({ id: d.id, move: null, error: String(err && err.message || err) });
  }
};
