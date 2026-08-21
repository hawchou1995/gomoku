'use strict';
// bridge_test.js — 验证 rapfi_bridge.js 接口（Node 模拟 Worker，须从 gomoku/ 根目录运行）
const path = require('path');
const ROOT = 'C:/Users/XAUTHUB/WorkBuddy/开发/gomoku';
global.Rapfi = require(path.join(ROOT, 'js/engine/rapfi/rapfi-single.js'));
require(path.join(ROOT, 'js/engine/rapfi_bridge.js'));  // IIFE 挂 globalThis
const bridge = globalThis.RapfiBridge;

(async function () {
  const t0 = Date.now();
  await bridge.init('js/engine/rapfi/');
  console.log('[init] RapfiBridge 就绪, 用时', ((Date.now() - t0) / 1000).toFixed(1) + 's');

  const r1 = await bridge.getMove([], 1500);
  console.log('[1] 空盘黑先 →', JSON.stringify(r1));

  const r2 = await bridge.getMove([{ x: 7, y: 7, player: 1 }], 1500);
  console.log('[2] 黑1=H8 后轮到白 →', JSON.stringify(r2));

  const r3 = await bridge.getMove([{ x: 7, y: 7, player: 1 }, { x: 6, y: 6, player: 2 }], 1500);
  console.log('[3] H8/G7 后轮到黑 →', JSON.stringify(r3));

  const valid = (mv) => mv && mv.x >= 0 && mv.x < 15 && mv.y >= 0 && mv.y < 15;
  console.log('[校验]', (valid(r1) && valid(r2) && valid(r3)) ? '全部合法' : '有非法!');
  console.log('[坐标] 游戏坐标 (x=A列, y=上到下: 0..14)');
  process.exit(0);
})();