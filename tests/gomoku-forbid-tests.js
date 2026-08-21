'use strict';
/**
 * gomoku-forbid-tests.js — 禁手跳三/跳四修复单测（GOKUP-002）
 *
 * 覆盖：
 *  1. 对局复现：前 22 手 + 黑 (5,4) 必须判三三（引擎 checkForbid + play 拒绝 + AI isForbidMove）
 *  2. 标准禁手样例回归：连续双三 / 跳三+连续三 / 双跳三 / 双四 / 活四+冲四 / 跳四+冲四 /
 *     双跳四 / 长连 / 恰五连（非禁手）/ 五连优先（五连+双活三不判禁）/ 眠三+活三（不判禁）/
 *     单活三 / 单冲四 / 四三（非禁手）/ 跳三被堵=眠三（不判禁）
 *  3. 引擎 checkForbid 与 AI.classifyPoint 全空点交叉校验（防漏判/过度判）
 *  4. 完整对局重放：禁手开启 → 第 23 手 (5,4) 判禁；禁手关闭 → 原 31 手全部合法、黑 y=9 五连胜
 *
 * 运行：node tests/gomoku-forbid-tests.js [replay.json]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const E = require(path.join(ROOT, 'js/engine.js'));
const AI = require(path.join(ROOT, 'js/ai.js'));
const REPLAY = process.argv[2] || 'C:/Users/XAUTHUB/Downloads/gomoku-game-2026-08-21T17-05-12-832Z.json';

const BLACK = E.BLACK, WHITE = E.WHITE, EMPTY = E.EMPTY;

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log('  [PASS] ' + msg); }
  else { fail++; console.log('  [FAIL] ' + msg); }
}
function section(name) { console.log('\n== ' + name + ' =='); }

// ── 工具 ──
function boardOf(stones) {
  const b = E.createBoard();
  stones.forEach(function (s) { E.set(b, s[0], s[1], s[2]); });
  return b;
}
function makeGame(b, forbidEnabled, turn) {
  const g = new E.Game();
  g.forbidEnabled = !!forbidEnabled;
  for (let i = 0; i < 15 * 15; i++) g.board[i] = b[i];
  g.turn = (turn === undefined ? BLACK : turn);
  return g;
}
function playMoves(g, moves) {
  for (const m of moves) {
    const r = g.play(m.x, m.y);
    if (!r.ok) return { ok: false, at: m, r: r };
  }
  return { ok: true };
}
function maxRun(b, x, y, p) {
  let m = 1;
  const dirs = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let d = 0; d < 4; d++) {
    const dx = dirs[d][0], dy = dirs[d][1];
    let c = 1, nx = x + dx, ny = y + dy;
    while (E.inB(nx, ny) && E.get(b, nx, ny) === p) { c++; nx += dx; ny += dy; }
    nx = x - dx; ny = y - dy;
    while (E.inB(nx, ny) && E.get(b, nx, ny) === p) { c++; nx -= dx; ny -= dy; }
    if (c > m) m = c;
  }
  return m;
}

// 引擎 checkForbid 与 AI classify/isForbidMove 在某点的一致性校验
function crossCheck(g, b, x, y, label) {
  const eng = g.checkForbid(x, y);
  const aiF = AI._forbid(b, x, y);
  const c = AI._classify(b, x, y, BLACK);
  const run = maxRun(b, x, y, BLACK);
  const five = (c.win > 0 && run === 5);       // 恰五连：黑胜优先
  const over = run >= 6;                       // 长连
  assert((eng === null) === (aiF === false), label + ': 引擎与AI禁手一致 eng=' + eng + ' aiF=' + aiF);
  if (eng && eng.indexOf('三三') >= 0) {
    assert(c.live3 >= 2, label + ': 引擎三三 ⇒ classify live3>=2 (got live3=' + c.live3 + ')');
  }
  if (eng && eng.indexOf('四四') >= 0) {
    assert(c.live4 + c.rush4 >= 2, label + ': 引擎四四 ⇒ classify live4+rush4>=2 (got ' + (c.live4 + c.rush4) + ')');
  }
  if (eng === null && c.live3 >= 2) {
    assert(five, label + ': 引擎不判三三但 live3>=2 ⇒ 须为五连优先 (run=' + run + ')');
  }
  if (eng === null && c.live4 + c.rush4 >= 2) {
    assert(five, label + ': 引擎不判四四但 four>=2 ⇒ 须为五连优先 (run=' + run + ')');
  }
  if (over && !eng) assert(false, label + ': 长连必须判禁');
  if (eng && eng.indexOf('长连') >= 0) assert(over, label + ': 判长连 ⇒ 确实连续>=6');
  return eng;
}

// 全盘扫描某局面所有空点：引擎 vs AI
function scanBoard(g, b, label) {
  for (let y = 0; y < 15; y++) {
    for (let x = 0; x < 15; x++) {
      if (E.get(b, x, y) !== EMPTY) continue;
      crossCheck(g, b, x, y, label + ' (' + x + ',' + y + ')');
    }
  }
}

// ── 回归样例：{ name, black:[...], white:[...], pt:[x,y], expect } ──
const SAMPLES = [
  { name: 'S1 连续双三', black: [[1,5],[3,5],[2,4],[2,6]], white: [], pt: [2,5], expect: '三三' },
  { name: 'S2 跳三+连续三(复现型)', black: [[3,6],[4,5],[6,4],[8,4]], white: [], pt: [5,4], expect: '三三' },
  { name: 'S3 双跳三', black: [[4,5],[7,5],[5,4],[5,7]], white: [], pt: [5,5], expect: '三三' },
  { name: 'S4 双冲四', black: [[6,5],[7,5],[8,5],[5,6],[5,7],[5,8]], white: [[9,5],[5,9]], pt: [5,5], expect: '四四' },
  { name: 'S5 活四+冲四', black: [[6,5],[7,5],[8,5],[5,6],[5,7],[5,8]], white: [[5,9]], pt: [5,5], expect: '四四' },
  { name: 'S6 跳四+冲四', black: [[7,5],[8,5],[9,5],[5,6],[5,7],[5,8]], white: [[5,9]], pt: [5,5], expect: '四四' },
  { name: 'S16 双跳四', black: [[7,5],[8,5],[9,5],[5,7],[5,8],[5,9]], white: [], pt: [5,5], expect: '四四' },
  { name: 'S7 长连(6子)', black: [[4,5],[5,5],[6,5],[7,5],[8,5]], white: [], pt: [3,5], expect: '长连' },
  { name: 'S8 恰五连(非禁手)', black: [[4,5],[5,5],[6,5],[7,5]], white: [], pt: [3,5], expect: null },
  { name: 'S9 五连+双活三(五连优先)', black: [[4,5],[5,5],[6,5],[7,5],[2,6],[4,4],[3,7],[3,8]], white: [], pt: [3,5], expect: null },
  { name: 'S10 活三+眠三(不判)', black: [[1,5],[3,5],[2,4],[2,6]], white: [[2,3]], pt: [2,5], expect: null },
  { name: 'S11 单活三(不禁)', black: [[1,5],[3,5]], white: [], pt: [2,5], expect: null },
  { name: 'S12 单冲四(不禁)', black: [[6,5],[7,5],[8,5]], white: [[9,5]], pt: [5,5], expect: null },
  { name: 'S13 四三(非禁手)', black: [[6,5],[7,5],[8,5],[5,4],[5,6]], white: [[9,5]], pt: [5,5], expect: null },
  { name: 'S14 活三+跳眠三(不禁手)', black: [[5,4],[5,6],[6,5],[8,5]], white: [[9,5]], pt: [5,5], expect: null },
  { name: 'S15 单跳四(不禁)', black: [[7,5],[8,5],[9,5]], white: [], pt: [5,5], expect: null }
];

section('0. 工具自检 / API 不变性');
(function () {
  const b = boardOf([]);
  const g = makeGame(b, false, BLACK);
  assert(g.checkForbid(7, 7) === null, '禁手关闭 ⇒ checkForbid=null');
  const g2 = makeGame(boardOf([]), true, WHITE);
  assert(g2.checkForbid(7, 7) === null, '白方回合 ⇒ checkForbid=null（禁手只判黑）');
})();

section('1. 对局复现：前22手 + 黑(5,4) 判三三');
(function () {
  const data = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
  const first22 = data.moves.slice(0, 22);
  const g = new E.Game();
  g.forbidEnabled = true;
  const r = playMoves(g, first22);
  assert(r.ok, '前 22 手均可正常落子（修复后无更早漏判）' + (r.ok ? '' : ' 失败于 ' + JSON.stringify(r.at) + ' -> ' + JSON.stringify(r.r)));
  assert(g.turn === BLACK, '前 22 手后轮到黑方');
  const b = g.board.slice();
  const eng = g.checkForbid(5, 4);
  assert(eng === '三三', 'checkForbid(5,4) === "三三"（实测 ' + eng + '）');
  const c = AI._classify(b, 5, 4, BLACK);
  assert(c.live3 === 2 && c.live4 + c.rush4 === 0, 'AI classifyPoint(5,4,BLACK)：live3=2、无四（实测 live3=' + c.live3 + ' four=' + (c.live4 + c.rush4) + '）');
  assert(AI._forbid(b, 5, 4) === true, 'AI isForbidMove(5,4) === true');
  // 干净盘面（前22手）全点交叉校验：引擎 vs AI
  scanBoard(g, g.board, '复现盘面');
  const pr = g.play(5, 4);
  assert(pr.ok === false && pr.reason === 'forbid' && pr.forbid === '三三', 'Game.play(5,4) → {ok:false, reason:forbid, forbid:三三}（实测 ' + JSON.stringify(pr) + '）');
  assert(E.get(g.board, 5, 4) === EMPTY, '判禁后落点回滚为空（不落子）');
  assert(g.moves.length === 22 && g.over === null, '判禁后局面未推进（moves=22, over=null）');
})();

section('2. 标准禁手样例回归');
SAMPLES.forEach(function (s) {
  const stones = s.black.map(function (a) { return [a[0], a[1], BLACK]; })
    .concat(s.white.map(function (a) { return [a[0], a[1], WHITE]; }));
  const b = boardOf(stones);
  const g = makeGame(b, true, BLACK);
  const eng = g.checkForbid(s.pt[0], s.pt[1]);
  const aiF = AI._forbid(b, s.pt[0], s.pt[1]);
  const expectEng = s.expect;
  const okEng = (expectEng === null && eng === null) || (expectEng !== null && eng && eng.indexOf(expectEng) >= 0);
  assert(okEng, s.name + ': 引擎期望 ' + expectEng + '，实测 ' + eng);
  assert(aiF === (expectEng !== null), s.name + ': AI 禁手期望 ' + (expectEng !== null) + '，实测 ' + aiF);
  const c = AI._classify(b, s.pt[0], s.pt[1], BLACK);
  if (expectEng === '三三') assert(c.live3 >= 2, s.name + ': classify live3>=2（实测 ' + c.live3 + '）');
  if (expectEng === '四四') assert(c.live4 + c.rush4 >= 2, s.name + ': classify four>=2（实测 ' + (c.live4 + c.rush4) + '）');
  // 该盘面全点交叉
  scanBoard(g, b, s.name);
});

section('3. 完整对局重放');
(function () {
  const data = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));

  // 3a. 禁手开启：第23手黑(5,4)判禁 → 对局止步于 22 手
  const gOn = new E.Game();
  gOn.forbidEnabled = true;
  const r22 = playMoves(gOn, data.moves.slice(0, 22));
  assert(r22.ok, '禁手开：前 22 手全部合法');
  const pr = gOn.play(5, 4);
  assert(pr.ok === false && pr.reason === 'forbid', '禁手开：第 23 手黑(5,4) 判禁（实测 ' + JSON.stringify(pr) + '）');
  assert(gOn.moves.length === 22 && gOn.over === null, '禁手开：对局在第 23 手被拦截（moves=22, over=null）');
  // 判禁后原 y=9 五连路径不可达：原第25/27/29/31手 (8,9)(7,9)(5,9)(4,9) 均未发生
  const nineCells = [8, 7, 5, 4].map(function (xx) { return E.get(gOn.board, xx, 9); });
  assert(nineCells.every(function (v) { return v !== BLACK; }),
    '判禁后原 y=9 五连所需的 (8,9)(7,9)(5,9)(4,9) 均未发生（实测 ' + nineCells.join(',') + '）');

  // 3b2 禁手关闭 → 原 31 手全部合法，黑 y=9 五连胜
  const gNo = new E.Game();
  gNo.forbidEnabled = false;
  const rAll = playMoves(gNo, data.moves);
  assert(rAll.ok, '禁手关：原 31 手全部可落（无回归破坏）');
  assert(gNo.over !== null && gNo.over.winner === BLACK, '禁手关：31 手后黑方五连胜（实测 winner=' + (gNo.over && gNo.over.winner) + '）');
  if (gNo.over && gNo.over.line) {
    assert(gNo.over.line.length >= 5 && gNo.over.line.every(function (p) { return p.y === 9; }),
      '禁手关：胜线为 y=9 五连（' + gNo.over.line.map(function (p) { return '(' + p.x + ',' + p.y + ')'; }).join(' ') + '）');
  }
})();

section('4. AI 威胁层与引擎判罚一致性（黑双活三 = 自陷禁手）');
(function () {
  const data = JSON.parse(fs.readFileSync(REPLAY, 'utf8'));
  const b = E.createBoard();
  data.moves.slice(0, 22).forEach(function (m) { E.set(b, m.x, m.y, m.player === 'black' ? BLACK : WHITE); });
  // 黑 (5,4) 双活三：引擎判三三禁手；AI 威胁层对黑方视为“自陷”（force=false，非必胜/必防点）
  const c = AI._classify(b, 5, 4, BLACK);
  const tlForbid = AI._threat(c, true);   // isBlackForbid = true（禁手开启）
  const tlOpen = AI._threat(c, false);    // isBlackForbid = false（对照）
  assert(tlForbid.force === false, '禁手开启：AI 对黑(5,4)双活三 force=false（黑自陷禁手，白方无需防该点）');
  assert(tlOpen.force === true, '对照：若引擎未判禁，AI 会将其视为必防 force=true（语义闭环）');
  assert(AI._forbid(b, 5, 4) === true, 'AI isForbidMove 与引擎一致判(5,4)禁手 ⇒ 白方“不防(5,4)”是正确行为，非防守崩盘');
})();

console.log('\n──────────────────────────────────────────');
console.log('结果：' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail > 0 ? 1 : 0);