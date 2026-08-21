/**
 * rapfi_bridge.js — Rapfi WASM（禁手 renju 15）协议桥（Web Worker 内，2026-08-22）
 *
 * 挂载到 self.RapfiBridge：
 *   init(engineDir)  → Promise（加载 wasm + NNUE 权重 + 配置禁手 RULE 2）
 *   isReady()        → bool
 *   getMove(history, ms) → Promise<{x,y}|null>  history:[{x,y,player}] game 坐标
 *
 * 坐标：引擎 y 轴自下而上（engine y=0 在底部），游戏 y 轴自上而下 → game(x,y)=(rx, 14-ry)。
 * 规则：禁手 renju（INFO RULE 2），黑无换手。black=1 white=2（engine.js 同款）。
 */
(function (self) {
  var RAPFI = null, READY = false;
  var latest = null;

  function locateFile(url, dir) {
    if (/^rapfi.*\.data$/.test(url)) url = 'rapfi.data';
    return dir + url;
  }
  function handleOut(o) {
    var s = String(o).trim();
    // Rapfi 输出的落子行是独立 "x,y" 行（其余为 MESSAGE/INFO 等）
    var m = /^(\d+),(\d+)$/.exec(s);
    if (m) latest = [+m[1], +m[2]];
  }

  function init(engineDir) {
    return new Promise(function (resolve, reject) {
      if (RAPFI) return resolve();
      if (typeof Rapfi === 'undefined') return reject(new Error('Rapfi script not loaded'));
      Rapfi({
        locateFile: function (u) { return locateFile(u, engineDir); },
        onReceiveStdout: handleOut,
        onReceiveStderr: function () {},
        setStatus: function () {},
        onExit: function () { RAPFI = null; READY = false; }
      }).then(function (inst) {
        RAPFI = inst;
        RAPFI.sendCommand('START 15');           // 15 路棋盘
        RAPFI.sendCommand('INFO RULE 2');        // 2 = 有禁手 renju 15
        RAPFI.sendCommand('INFO THREAD_NUM 1');  // 单线程 WASM
        RAPFI.sendCommand('INFO CAUTION_FACTOR 3'); // 三圈半选点
        RAPFI.sendCommand('INFO STRENGTH 100');  // 满棋力
        RAPFI.sendCommand('INFO MAX_NODE 4000000');
        RAPFI.sendCommand('INFO PONDERING 0');
        READY = true;
        resolve();
      }).catch(reject);
    });
  }

  function isReady() { return READY && !!RAPFI; }

  function getMove(history, ms) {
    return new Promise(function (resolve, reject) {
      if (!isReady()) return reject(new Error('Rapfi not ready'));
      latest = null;
      RAPFI.sendCommand('INFO TIMEOUT_TURN ' + Math.max(50, (ms | 0)));
      var cmd = 'YXBOARD';
      for (var i = 0; i < history.length; i++) {
        var h = history[i];
        var side = (h.player === 1) ? 1 : 2;   // black=1 → side 1
        if (typeof h.player === 'undefined') side = (i % 2 === 0) ? 1 : 2;
        cmd += ' ' + h.x + ',' + (14 - h.y) + ',' + side;
      }
      cmd += ' DONE';
      RAPFI.sendCommand(cmd);
      RAPFI.sendCommand('YXNBEST 1');
      var t0 = Date.now();
      var iv = setInterval(function () {
        if (latest && Date.now() - t0 > 250) {
          clearInterval(iv);
          resolve({ x: latest[0], y: 14 - latest[1] });
        } else if (Date.now() - t0 > (ms + 30000)) {
          clearInterval(iv);
          resolve(latest ? { x: latest[0], y: 14 - latest[1] } : null);
        }
      }, 80);
    });
  }

  self.RapfiBridge = { init: init, isReady: isReady, getMove: getMove };
})(typeof self !== 'undefined' ? self : globalThis);
