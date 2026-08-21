/**
 * ai_worker.js — 五子棋 AI 搜索 Web Worker（2026-08-22 集成 Rapfi 主引擎）
 *
 * 主引擎：Rapfi（禁手 renju 15，离线 WASM，NNUE 神经网络评估）——棋力远超启发式 AI。
 * 降级链：Rapfi 未就绪/失败/落子非法 → 现 AI（GomokuAI.getBestMove）。
 * 难度：段位映射思考时间 ms（Rapfi 低档自动压缩思考、保留强棋力内核）。
 *
 * 协议（兼容 app.js think()）：
 *   onmessage 收到 { id, board(Array), player, level, ms, forbidEnabled, history:[{x,y,player}] }
 *   postMessage({ id, move: {x,y} | null })
 */
importScripts(
  'engine.js',
  'ai.js',
  'net_forward.js',
  'engine/rapfi/rapfi-single.js',
  'engine/rapfi_bridge.js'
);

// model/best_net.js 定义 window.GOMOKU_MODEL —— Worker 里没有 window，shim 一下
self.window = self;
try { importScripts('../model/best_net.js'); } catch (e) { /* 模型缺失不致命，启发式引擎照跑 */ }

// 融合网络（可选）：注册到 GomokuAI（仅 Rapfi 降级时走它；模型可用时 policy 融入候选池）
try {
  if (self.GOMOKU_MODEL) {
    var nf = new self.NetForward();
    nf.weights = self.GOMOKU_MODEL;
    nf._flatten();
    nf.loaded = true;
    self.GomokuAI._useNet(nf);
  }
} catch (e) { /* 网络加载失败 → 纯启发式引擎 */ }

// 异步初始化 Rapfi 主引擎（不阻塞 onmessage；失败静默降级现 AI）
self.RapfiBridge.init('engine/rapfi/').then(function () {
  self.postMessage({ type: 'rapfi_ready' });
}).catch(function () { /* Rapfi 加载失败 → 全程降级现 AI */ });

function fallbackMove(d) {
  try {
    return self.GomokuAI.getBestMove(d.board, d.player, d.level, Date.now() + d.ms, d.forbidEnabled, d.history || []);
  } catch (e) { return null; }
}
function validMove(board, mv) {
  if (!mv || typeof mv.x !== 'number' || typeof mv.y !== 'number') return false;
  if (mv.x < 0 || mv.x >= 15 || mv.y < 0 || mv.y >= 15) return false;
  return !board || board[mv.y * 15 + mv.x] === 0; // 空位才合法
}

self.onmessage = function (ev) {
  var d = ev.data;
  try {
    // 主线程可查询 Rapfi 就绪状态（用于展示"顶级 AI"加载中）
    if (d.type === 'rapfi_status') {
      self.postMessage({ id: d.id, rapfiReady: self.RapfiBridge.isReady() });
      return;
    }
    if (self.RapfiBridge.isReady()) {
      self.RapfiBridge.getMove(d.history || [], d.ms).then(function (mv) {
        if (mv && validMove(d.board, mv)) {
          self.postMessage({ id: d.id, move: mv });
        } else {
          // Rapfi 落子非法/超时 → 降级现 AI（避免主线程 play 失败卡死）
          self.postMessage({ id: d.id, move: fallbackMove(d) });
        }
      }).catch(function () {
        self.postMessage({ id: d.id, move: fallbackMove(d) });
      });
    } else {
      self.postMessage({ id: d.id, move: fallbackMove(d) });
    }
  } catch (err) {
    self.postMessage({ id: d.id, move: fallbackMove(d), error: String(err && err.message || err) });
  }
};
