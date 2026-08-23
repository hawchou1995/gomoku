/* ════════════════════════════════════════════════════════════════════
 * qa_verify-v127.js — Task #82 独立验证（严守真 / quality-lead）
 * --------------------------------------------------------------------
 * 铁律：不信任 engineering-lead 自测（31/31），本脚本独立编写、独立运行、
 *       独立下结论。可读 selftest-v127.js 了解环境，但断言口径/结构独立。
 *
 * 覆盖矩阵：
 *   S1 大厅禁下拉（412×915 手机竖屏）：touch-action / overscroll / 真实
 *     CDP 触摸拖动（双向）/ scrollTop 恒 0 / lockHomeScroll 绑定
 *   S2 竖屏沉浸居中（412×915 进对局→开局）：棋盘铺满宽、顶条72/底条64
 *     间垂直居中（Δ≤2）、零滚动、CDP 双向拖动位移=0、落子像素验证
 *   S3 桌面宽屏用满（1440×900 非沉浸）：棋盘 764、水平居中、layout 1440
 *   S4 桌面沉浸（1440×900）：棋盘 764、水平/垂直居中、零滚动
 *   S5 横屏 915×412 非沉浸：棋盘 304（min 语义，高度受限属正常）、水平居中
 *   S6 360×640 小屏沉浸：HUD 顶/底与棋盘无重叠、零滚动（记录实测边长）
 *   R1 回归全链路（412×915）：大厅→进对局→开局→落子→AI 回手 + 记录
 *     开局瞬间棋盘移动幅度（用户已接受，只记录不判 FAIL）+ 0 页面错误
 *
 * 运行：
 *   NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
 *   C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe \
 *   C:/Users/XAUTHUB/WorkBuddy/开发/gomoku/cache/qa_verify-v127.js
 * 输出：同目录 qa_verify-v127-result.json
 * ════════════════════════════════════════════════════════════════════ */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, 'qa_verify-v127-result.json');

// ───────────────────────── 断言收集器 ─────────────────────────
const asserts = [];
const pageErrors = []; // 全局：{scene, kind, text}
const records = [];    // 记录项（不判 PASS/FAIL，如开局移动幅度）
let seq = 0;

function A(name, ok, actual, expected) {
  seq++;
  asserts.push({ id: 'V' + seq, name, ok: !!ok, actual: actual === undefined ? '' : String(actual), expected: expected === undefined ? '' : String(expected) });
  console.log((ok ? 'PASS' : 'FAIL') + '  V' + seq + '  ' + name + (ok ? '' : '  ← 期望 ' + expected) + '  [实测 ' + (actual === undefined ? '' : JSON.stringify(actual)) + ']');
}
function R(name, value) {
  const v = value === undefined ? '' : (typeof value === 'object' ? JSON.stringify(value) : String(value));
  records.push({ name, value: v });
  console.log('REC  ' + name + '  = ' + v);
}

// ───────────────────────── 页面工厂 ─────────────────────────
function newPage(browser, w, h, touch, scene) {
  return browser.newPage({
    viewport: { width: w, height: h },
    isMobile: !!touch,
    hasTouch: !!touch,
  }).then((page) => {
    page.on('pageerror', (e) => pageErrors.push({ scene, kind: 'pageerror', text: String(e).slice(0, 300) }));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push({ scene, kind: 'console', text: m.text().slice(0, 300) }); });
    return page;
  });
}

// ───────────────────────── 几何测量（独立口径） ─────────────────────────
async function geom(page) {
  return page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { x: +(b.x).toFixed(1), y: +(b.y).toFixed(1), w: +(b.width).toFixed(1), h: +(b.height).toFixed(1) };
    };
    const cs = (el, p) => (el ? getComputedStyle(el)[p] : null);
    const out = {
      vw: window.innerWidth, vh: window.innerHeight,
      dpr: window.devicePixelRatio || 1,
      doc: {
        scrollW: document.documentElement.scrollWidth,
        clientW: document.documentElement.clientWidth,
        scrollH: document.documentElement.scrollHeight,
        clientH: document.documentElement.clientHeight,
        scrollTop: (document.scrollingElement || document.documentElement).scrollTop,
        winY: window.scrollY,
      },
    };
    const home = document.getElementById('view-home');
    if (home) {
      const hs = getComputedStyle(home);
      out.home = {
        rect: rect(home),
        touchAction: hs.touchAction,
        overscrollX: hs.overscrollBehaviorX,
        overscrollY: hs.overscrollBehaviorY,
        scrollTop: home.scrollTop, scrollLeft: home.scrollLeft,
        scrollW: home.scrollWidth, clientW: home.clientWidth,
        scrollH: home.scrollHeight, clientH: home.clientHeight,
        locked: home.dataset.lockHome === '1',
      };
    }
    const bs = document.querySelector('.board-scroll');
    if (bs) {
      const bcs = getComputedStyle(bs);
      out.boardScroll = {
        padT: parseFloat(bcs.paddingTop) || 0,
        padB: parseFloat(bcs.paddingBottom) || 0,
        scrollW: bs.scrollWidth, clientW: bs.clientWidth,
        scrollH: bs.scrollHeight, clientH: bs.clientHeight,
        scrollTop: bs.scrollTop, scrollLeft: bs.scrollLeft,
        locked: bs.dataset.lockBoard === '1',
      };
    }
    const bw = document.querySelector('.board-wrap');
    if (bw) out.board = rect(bw);
    const gl = document.querySelector('#view-game .game-layout');
    if (gl) out.gameLayout = { rect: rect(gl), maxWidth: cs(gl, 'maxWidth') };
    const hudTop = document.querySelector('.hud-top');
    const hudPlayers = document.querySelector('.hud-players');
    const hudBottom = document.querySelector('.hud-bottom');
    out.hud = {
      topZoneBottom: (hudTop ? hudTop.getBoundingClientRect().bottom : 0) + (hudPlayers ? hudPlayers.getBoundingClientRect().height : 0),
      bottomZoneTop: hudBottom ? hudBottom.getBoundingClientRect().top : Infinity,
    };
    return out;
  });
}

// ───────────────────────── CDP 真实触摸 ─────────────────────────
// 返回该次序列中页面观察到的 touchmove 记录（{x,y,defaultPrevented}）
async function cdpTouchSeq(page, pts) {
  await page.evaluate(() => {
    if (!window.__qaTouchObs) window.__qaTouchObs = [];
    if (!window.__qaTouchListener) {
      window.__qaTouchListener = true;
      document.addEventListener('touchmove', (e) => {
        window.__qaTouchObs.push({
          x: e.touches.length ? Math.round(e.touches[0].clientX) : null,
          y: e.touches.length ? Math.round(e.touches[0].clientY) : null,
          defaultPrevented: e.defaultPrevented,
        });
      }, { passive: true });
    }
  });
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(pts[0][0], pts[0][1]) });
  await page.waitForTimeout(60);
  for (let i = 1; i < pts.length; i++) {
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(pts[i][0], pts[i][1]) });
    await page.waitForTimeout(60);
  }
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(180);
  const obs = await page.evaluate(() => { const r = window.__qaTouchObs.slice(); window.__qaTouchObs.length = 0; return r; });
  return obs;
}

// ───────────────────────── 页面动作 ─────────────────────────
async function enterGame(page) {
  await page.click('#btn-enter-ai');
  await page.waitForTimeout(400);
}
async function startGame(page) {
  await page.evaluate(() => document.getElementById('btn-start-ai').click());
  await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 5000 });
  await page.waitForTimeout(400);
}
async function statusText(page) {
  return (await page.textContent('#game-status')).trim();
}

// 黑子像素断言：采样天元交点上方 (0,-7) 偏移 5×5 补丁的平均亮度。
// 该点落在石子实体上，避开：中央金色步数标注、末手金环(r≈8.75)、网格星点(r=3)。
// 空板≈木纹亮(~200+)，落黑子后≈暗(<100)，前后差稳定 ~100px。
async function stoneLum(page) {
  return page.evaluate(() => {
    const cv = document.getElementById('board');
    const scale = cv.width / cv.getBoundingClientRect().width;
    const ctx = cv.getContext('2d');
    const cx = Math.round(cv.width / 2), cy = Math.round(cv.height / 2);
    const ox = 0, oy = Math.round(-7 * scale);
    let sum = 0, n = 0;
    for (let dy = -2; dy <= 2; dy += 2) {
      for (let dx = -2; dx <= 2; dx += 2) {
        const d = ctx.getImageData(cx + ox + dx, cy + oy + dy, 1, 1).data;
        sum += (d[0] + d[1] + d[2]) / 3; n++;
      }
    }
    return { avg: +(sum / n).toFixed(1) };
  });
}

// 等待状态回到"轮到你"（AI 回手完成）
async function waitForMyTurn(page, timeoutMs) {
  const t0 = Date.now();
  let st = await statusText(page);
  while (Date.now() - t0 < timeoutMs && /思考/.test(st)) {
    await page.waitForTimeout(250);
    st = await statusText(page);
  }
  return st;
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  const startedAt = new Date().toISOString();

  // ═══════════════ S1 大厅禁下拉（412×915 手机竖屏）═══════════════
  {
    const page = await newPage(browser, 412, 915, true, 'S1');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const g0 = await geom(page);

    A('#view-home computed touch-action=none', g0.home && g0.home.touchAction === 'none', g0.home && g0.home.touchAction, 'none');
    A('#view-home computed overscroll-behavior-y=none', g0.home && g0.home.overscrollY === 'none', g0.home && g0.home.overscrollY, 'none');
    A('#view-home 已绑定 lockHomeScroll(dataset.lockHome=1)', g0.home && g0.home.locked === true, g0.home && g0.home.locked, true);
    const homeOverflow = g0.home && (g0.home.scrollH > g0.home.clientH + 1 || g0.home.scrollW > g0.home.clientW + 1);
    const docOverflow = g0.doc.scrollH > g0.doc.clientH + 1 || g0.doc.scrollW > g0.doc.clientW + 1;
    A('大厅内容无溢出（记录，供后续拖动锁验证）', !(homeOverflow || docOverflow),
      'home ' + (g0.home ? g0.home.scrollH + '/' + g0.home.clientH + 'x' + g0.home.scrollW + '/' + g0.home.clientW : 'n/a') + ' doc ' + g0.doc.scrollH + '/' + g0.doc.clientH,
      'home.scrollH≤clientH 且 doc.scrollH≤clientH（溢出也不判死，见拖动锁）');

    // 真实 CDP 触摸：向下拉 120px
    const obsDown = await cdpTouchSeq(page, [[200, 300], [200, 420]]);
    const g1 = await geom(page);
    const obsUp = await cdpTouchSeq(page, [[200, 400], [200, 280]]); // 反向推回
    const g2 = await geom(page);

    A('CDP 触摸序列产生 touchmove 事件（≥1）', obsDown.length >= 1, 'obs=' + obsDown.length, '≥1');
    A('touchmove 全部被 preventDefault（锁生效）', obsDown.length > 0 && obsDown.every(o => o.defaultPrevented === true),
      JSON.stringify(obsDown), 'defaultPrevented=true 全部');
    A('向下拖动 120px 后 scrollY/scrollTop 恒 0', g1.doc.winY === 0 && g1.doc.scrollTop === 0 && g1.home.scrollTop === 0,
      'winY=' + g1.doc.winY + ' docST=' + g1.doc.scrollTop + ' homeST=' + g1.home.scrollTop, '0/0/0');
    A('反向向上推 120px 后仍 scrollY=0（双向禁滚）', g2.doc.winY === 0 && g2.doc.scrollTop === 0 && g2.home.scrollTop === 0,
      'winY=' + g2.doc.winY + ' homeST=' + g2.home.scrollTop, '0/0');
    await page.close();
  }

  // ═══════════════ S2 竖屏对局沉浸居中（412×915）═══════════════
  {
    const page = await newPage(browser, 412, 915, true, 'S2');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const pre = await geom(page);
    await startGame(page);
    const g = await geom(page);

    A('S2 开局后沉浸态生效', g.vh === 915 && !!g.board, JSON.stringify({ vh: g.vh, board: g.board }), 'immersive');
    A('S2 棋盘宽=412（铺满屏宽）', g.board && Math.abs(g.board.w - 412) <= 2, g.board && g.board.w, '412');
    A('S2 棋盘水平铺满（x=0, 右 gap=0）', g.board && Math.abs(g.board.x) <= 2 && Math.abs(412 - (g.board.x + g.board.w)) <= 2,
      'x=' + g.board.x + ' rightGap=' + (412 - (g.board.x + g.board.w)).toFixed(1), '0/0');

    // 顶条(72)/底条(64)之间垂直居中：expected.y = padT + (内容高 - 棋盘边长)/2
    const bs = g.boardScroll;
    const contentH = g.vh - bs.padT - bs.padB;
    const expectedY = bs.padT + (contentH - g.board.h) / 2;
    const topGap = g.board.y;                    // 视口顶 → 棋盘顶
    const bottomGap = g.vh - (g.board.y + g.board.h); // 棋盘底 → 视口底
    A('S2 垂直居中于顶条/底条之间（偏差≤2px）', Math.abs(g.board.y - expectedY) <= 2,
      'board.y=' + g.board.y.toFixed(1) + ' 期望=' + expectedY.toFixed(1) + ' topGap=' + topGap.toFixed(1) + ' bottomGap=' + bottomGap.toFixed(1),
      '|y-期望|≤2');
    R('S2 视口顶 gap / 底 gap（72≠64 结构差 8px 属预期）', { topGap: +topGap.toFixed(1), bottomGap: +bottomGap.toFixed(1), delta: +(Math.abs(topGap - bottomGap)).toFixed(1) });
    R('S2 padding-top/padding-bottom', { padT: bs.padT, padB: bs.padB });

    A('S2 沉浸零滚动（scrollW/H ≤ clientW/H）', g.doc.scrollW <= g.doc.clientW && g.doc.scrollH <= g.doc.clientH && g.boardScroll.scrollW <= g.boardScroll.clientW,
      'doc ' + g.doc.scrollW + '/' + g.doc.clientW + 'x' + g.doc.scrollH + '/' + g.doc.clientH + ' bs ' + g.boardScroll.scrollW + '/' + g.boardScroll.clientW,
      '无溢出');

    // 双向触摸拖动：棋盘位移必须为 0
    const cx = g.board.x + g.board.w / 2, cy = g.board.y + g.board.h / 2;
    await cdpTouchSeq(page, [[cx, cy], [cx, cy + 120]]);
    const gDown = await geom(page);
    A('S2 棋盘上向下拖 120px → 棋盘位移=0、页面 scrollY=0',
      gDown.board && gDown.board.x === g.board.x && gDown.board.y === g.board.y && gDown.doc.winY === 0,
      'before=' + JSON.stringify(g.board) + ' after=' + JSON.stringify(gDown.board) + ' winY=' + gDown.doc.winY, '位移 0');
    await cdpTouchSeq(page, [[cx, cy], [cx, cy - 120]]);
    const gUp = await geom(page);
    A('S2 棋盘上向上拖 120px → 棋盘位移=0、scrollY=0',
      gUp.board.x === g.board.x && gUp.board.y === g.board.y && gUp.doc.winY === 0,
      'after=' + JSON.stringify(gUp.board) + ' winY=' + gUp.doc.winY, '位移 0');

    // 落子可用：空板亮度基线 → 点天元 → 黑子出现（(0,-7) 石子实体亮度前后差）
    await page.mouse.move(5, 5); // 鼠标移开棋盘，避免准星污染基线
    const lumBefore = await stoneLum(page);
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(150);
    const st = await statusText(page);
    A('S2 落子被接受（状态进入 AI 思考）', /AI 思考|思考/.test(st), st, '含"思考"');
    const lumAfter = await stoneLum(page);
    A('S2 像素验证：天元出现黑子（采样点亮→暗，差>60）',
      lumAfter.avg < lumBefore.avg - 60 && lumAfter.avg < 150,
      'before=' + lumBefore.avg + ' after=' + lumAfter.avg + ' Δ=' + (lumBefore.avg - lumAfter.avg).toFixed(1),
      'Δ>60 且 after<150');
    await page.close();
  }

  // ═══════════════ S3 桌面宽屏用满（1440×900 非沉浸）═══════════════
  {
    const page = await newPage(browser, 1440, 900, false, 'S3');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const g = await geom(page);

    A('S3 桌面非沉浸 棋盘宽=764（480 竖栏上限已放开）', g.board && Math.abs(g.board.w - 764) <= 2, g.board && g.board.w, '764');
    A('S3 棋盘水平居中（|cx-720|≤2）', g.board && Math.abs((g.board.x + g.board.w / 2) - 720) <= 2,
      'cx=' + (g.board.x + g.board.w / 2).toFixed(1), '≈720');
    A('S3 .game-layout max-width=none', g.gameLayout && g.gameLayout.maxWidth === 'none', g.gameLayout && g.gameLayout.maxWidth, 'none');
    A('S3 .game-layout 宽=1440（铺满视口）', g.gameLayout && Math.abs(g.gameLayout.rect.w - 1440) <= 2, g.gameLayout && g.gameLayout.rect.w, '1440');
    A('S3 无横向溢出', g.doc.scrollW <= g.doc.clientW, g.doc.scrollW + '≤' + g.doc.clientW, '无溢出');
    await page.close();
  }

  // ═══════════════ S4 桌面沉浸（1440×900）═══════════════
  {
    const page = await newPage(browser, 1440, 900, false, 'S4');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    await startGame(page);
    const g = await geom(page);
    const bs = g.boardScroll;
    const expectedY = bs.padT + ((900 - bs.padT - bs.padB) - g.board.h) / 2;

    A('S4 桌面沉浸 棋盘宽=764', g.board && Math.abs(g.board.w - 764) <= 2, g.board && g.board.w, '764');
    A('S4 水平居中（|cx-720|≤2）', g.board && Math.abs((g.board.x + g.board.w / 2) - 720) <= 2,
      'cx=' + (g.board.x + g.board.w / 2).toFixed(1), '≈720');
    A('S4 在 (72, 836) 间垂直居中（偏差≤2px）', Math.abs(g.board.y - expectedY) <= 2,
      'y=' + g.board.y.toFixed(1) + ' 期望=' + expectedY.toFixed(1) + ' topGap=' + g.board.y.toFixed(1) + ' bottomGap=' + (900 - (g.board.y + g.board.h)).toFixed(1),
      '|y-期望|≤2');
    A('S4 零滚动', g.doc.scrollW <= g.doc.clientW && g.doc.scrollH <= g.doc.clientH && g.doc.winY === 0,
      'doc ' + g.doc.scrollW + '/' + g.doc.clientW + ' winY=' + g.doc.winY, '无滚动');
    await page.close();
  }

  // ═══════════════ S5 横屏 915×412 非沉浸 ═══════════════
  {
    const page = await newPage(browser, 915, 412, true, 'S5');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const g = await geom(page);
    A('S5 横屏 棋盘宽=304（min 语义，高度受限属正常）', g.board && Math.abs(g.board.w - 304) <= 2, g.board && g.board.w, '304');
    A('S5 水平居中（|cx-457.5|≤2）', g.board && Math.abs((g.board.x + g.board.w / 2) - 457.5) <= 2,
      'cx=' + (g.board.x + g.board.w / 2).toFixed(1) + ' left=' + g.board.x.toFixed(1) + ' right=' + (915 - (g.board.x + g.board.w)).toFixed(1), '≈457.5');
    A('S5 无横向溢出', g.doc.scrollW <= g.doc.clientW, g.doc.scrollW + '≤' + g.doc.clientW, '无溢出');
    await page.close();
  }

  // ═══════════════ S6 360×640 小屏沉浸 ═══════════════
  {
    const page = await newPage(browser, 360, 640, true, 'S6');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    await startGame(page);
    const g = await geom(page);
    const bs = g.boardScroll;
    const hudTopBottom = g.hud.topZoneBottom;
    const hudBotTop = g.hud.bottomZoneTop;
    A('S6 HUD 顶区不压棋盘（棋盘顶 ≥ HUD 顶区底）', g.board && g.board.y >= hudTopBottom - 1,
      'board.y=' + (g.board && g.board.y) + ' hudTopBottom=' + hudTopBottom.toFixed(1), 'board.y≥hudTopBottom');
    A('S6 HUD 底条不压棋盘（棋盘底 ≤ HUD 底条顶）', g.board && (g.board.y + g.board.h) <= hudBotTop + 1,
      'boardBottom=' + (g.board.y + g.board.h).toFixed(1) + ' hudBottomTop=' + hudBotTop.toFixed(1), '≤');
    A('S6 零滚动', g.doc.scrollW <= g.doc.clientW && g.doc.scrollH <= g.doc.clientH && g.doc.winY === 0,
      'doc ' + g.doc.scrollW + '/' + g.doc.clientW + 'x' + g.doc.scrollH + '/' + g.doc.clientH, '无滚动');
    R('S6 小屏实测棋盘边长（任务标注 210 为 min() 语义参考，代码语义 min(360,640-136)=360）', g.board && g.board.w);
    await page.close();
  }

  // ═══════════════ R1 回归全链路（412×915）═══════════════
  {
    const page = await newPage(browser, 412, 915, true, 'R1');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const st0 = await statusText(page);
    A('R1 进对局未开局：状态=等待开局', /等待开局/.test(st0), st0, '等待开局');

    const pre = await geom(page);
    await startGame(page);
    const post = await geom(page);
    const st1 = await statusText(page);
    A('R1 开局后玩家先手：状态=轮到你', /轮到你/.test(st1), st1, '轮到你');
    R('R1 开始对局瞬间棋盘位移（用户已接受，仅记录不判 FAIL）', {
      before: pre.board, after: post.board,
      dx: +(post.board.x - pre.board.x).toFixed(1), dy: +(post.board.y - pre.board.y).toFixed(1),
    });

    // 落子（天元）→ AI 回手
    const cx = post.board.x + post.board.w / 2, cy = post.board.y + post.board.h / 2;
    await page.mouse.move(5, 5);
    const lumBefore = await stoneLum(page);
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(150);
    const st2 = await statusText(page);
    A('R1 落子被接受：状态进入 AI 思考', /AI 思考|思考/.test(st2), st2, 'AI 思考');
    const lumAfter = await stoneLum(page);
    A('R1 像素验证：天元出现黑子（采样点亮→暗，差>60）',
      lumAfter.avg < lumBefore.avg - 60 && lumAfter.avg < 150,
      'before=' + lumBefore.avg + ' after=' + lumAfter.avg + ' Δ=' + (lumBefore.avg - lumAfter.avg).toFixed(1),
      'Δ>60 且 after<150');

    const stBack = await waitForMyTurn(page, 12000);
    A('R1 AI 回手完成：状态回到轮到你', /轮到你/.test(stBack), stBack, '轮到你');
    const gEnd = await geom(page);
    A('R1 对局中零滚动', gEnd.doc.scrollW <= gEnd.doc.clientW && gEnd.doc.winY === 0,
      'doc ' + gEnd.doc.scrollW + '/' + gEnd.doc.clientW + ' winY=' + gEnd.doc.winY, '无滚动');
    await page.close();
  }

  // ═══════════════ 汇总 ═══════════════
  const errCount = pageErrors.length;
  A('全程 pageerror/console.error = 0', errCount === 0, errCount ? pageErrors.map(e => e.scene + ':' + e.kind + ':' + e.text).join(' | ').slice(0, 400) : '0', '0');

  await browser.close();

  const summary = {
    generatedAt: new Date().toISOString(),
    script: 'qa_verify-v127.js',
    verifier: '严守真 / quality-lead（独立验证，非工程自测）',
    base: BASE,
    total: asserts.length,
    passed: asserts.filter(a => a.ok).length,
    failed: asserts.filter(a => !a.ok).length,
    asserts,
    records,
    pageErrors,
  };
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log('\n════════ qa_verify-v127 汇总 ════════');
  console.log('PASS ' + summary.passed + ' / ' + summary.total + (summary.failed ? '  FAIL ' + summary.failed : ''));
  console.log('records: ' + records.length + '  pageErrors: ' + pageErrors.length);
  console.log('结果 → ' + OUT);
  process.exit(summary.failed ? 1 : 0);
})().catch((e) => { console.error('QA_VERIFY_CRASH', e); process.exit(2); });
