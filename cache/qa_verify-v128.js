/* ════════════════════════════════════════════════════════════════════
   QA 独立验证 v1.2.8（Task #90 · P0）
   验证者：严守真（quality-lead）—— 不信任 engineering-lead 自测，独立重写断言。
   目标：
     A. 大厅一屏自适应（5 视口：412×915 / 360×640 / 412×568 极矮 / 320×568 / 844×390 横屏）
     B. 两态棋盘同矩形（412×915：非沉浸 dock 态 vs 沉浸态，rect 全等 Δ=0）
     C. dock 覆盖层不遮棋盘 + 沉浸态居中 + 两态零滚动零拖动
     D. 小屏回归（360×640 两态同矩形；412×568 极矮无溢出）
     E. 回归链路（大厅→进对局→开始→落子天元→AI 回手）+ 抽屉 z 序
     F. 全程 pageerror / console.error = 0
   运行：
     NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
     C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/qa_verify-v128.js
   结果 JSON → cache/qa_verify-v128-result.json
   ════════════════════════════════════════════════════════════════════ */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, 'qa_verify-v128-result.json');

const results = [];
const allPageErrors = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function check(ok, name, detail) {
  results.push({ ok: !!ok, name: name, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

async function newPage(browser, w, h) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    isMobile: true,
    hasTouch: true,
  });
  page.on('pageerror', (e) => allPageErrors.push('pageerror:' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') allPageErrors.push('console:' + m.text()); });
  return page;
}

async function gotoHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('btn-enter-ai'), null, { timeout: 15000 });
  await page.waitForTimeout(500);
}

// ── CDP 触摸拖动（独立实现）──
async function touchDrag(page, x0, y0, x1, y1) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x1, y1) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
}

/* ── 大厅测量 ── */
async function measureHome(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY, scrollX: window.scrollX };
    const home = document.getElementById('view-home');
    if (home) {
      const cs = getComputedStyle(home);
      out.home = {
        clientH: home.clientHeight, scrollH: home.scrollHeight,
        clientW: home.clientWidth, scrollW: home.scrollWidth,
        scrollTop: home.scrollTop,
        lock: home.dataset.lockHome === '1',
        display: cs.display, overflow: cs.overflow,
      };
    }
    out.heroTitle = !!(document.querySelector('#view-home .home-title') &&
      document.querySelector('#view-home .home-title').textContent.trim());
    out.heroSub = !!(document.querySelector('#view-home .home-sub') &&
      document.querySelector('#view-home .home-sub').textContent.trim());
    out.cards = Array.from(document.querySelectorAll('#view-home .mode-card')).map((c) => {
      const r = c.getBoundingClientRect();
      const btns = Array.from(c.querySelectorAll('.btn')).map((b) => {
        const br = b.getBoundingClientRect();
        return { top: br.top, bottom: br.bottom, left: br.left, right: br.right };
      });
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, btns };
    });
    out.doc = {
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight,
    };
    return out;
  });
}

/* ── 对局测量 ── */
async function measureGame(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY, scrollX: window.scrollX };
    const wrap = document.querySelector('.board-wrap');
    const canvas = document.getElementById('board');
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    out.wrap = rectOf(wrap);
    out.canvas = rectOf(canvas);
    const bs = document.querySelector('.board-scroll');
    if (bs) {
      const cs = getComputedStyle(bs);
      out.boardScroll = {
        padT: parseFloat(cs.paddingTop) || 0,
        padB: parseFloat(cs.paddingBottom) || 0,
        padL: parseFloat(cs.paddingLeft) || 0,
        padR: parseFloat(cs.paddingRight) || 0,
        clientW: bs.clientWidth, scrollW: bs.scrollWidth,
        clientH: bs.clientHeight, scrollH: bs.scrollHeight,
        scrollTop: bs.scrollTop, scrollLeft: bs.scrollLeft,
        touchAction: cs.touchAction,
        lock: bs.dataset.lockBoard === '1',
      };
    }
    const dock = document.getElementById('ai-setup');
    if (dock) {
      const dr = dock.getBoundingClientRect();
      const dcs = getComputedStyle(dock);
      out.dock = {
        top: dr.top, bottom: dr.bottom, left: dr.left, right: dr.right, w: dr.width, h: dr.height,
        overlay: dock.classList.contains('dock-overlay'),
        position: dcs.position, zIndex: dcs.zIndex,
        inViewGame: dock.parentElement && dock.parentElement.id === 'view-game',
      };
    }
    out.dockHVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--v128-dock-h')) || 0;
    out.immersive = document.body.classList.contains('immersive');
    out.hud = !document.getElementById('hud').classList.contains('hidden');
    out.status = (document.getElementById('game-status') || {}).textContent || '';
    out.drawer = document.querySelector('.side-panel').classList.contains('open');
    out.doc = {
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight,
    };
    return out;
  });
}

async function enterGame(page) {
  await page.click('#btn-enter-ai');
  await page.waitForFunction(() => {
    const v = document.getElementById('view-game');
    return v && !v.classList.contains('hidden') && !!document.querySelector('.board-wrap');
  }, null, { timeout: 5000 });
  await page.waitForTimeout(400);
}

async function startGame(page) {
  await page.evaluate(() => document.getElementById('btn-start-ai').click());
  await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 5000 });
  await page.waitForTimeout(400);
}

/* ═══ A. 大厅一屏（5 视口）═══ */
async function verifyHome(browser, vp) {
  const page = await newPage(browser, vp.w, vp.h);
  await gotoHome(page);
  const tag = vp.tag;
  const m = await measureHome(page);

  check(m.home && m.home.scrollH <= m.home.clientH + 1,
    `A[${tag}] #view-home 无垂直内部滚动`,
    `scrollH=${m.home && m.home.scrollH} clientH=${m.home && m.home.clientH}`);
  check(m.home && m.home.scrollW <= m.home.clientW + 1,
    `A[${tag}] #view-home 无水平内部滚动`,
    `scrollW=${m.home && m.home.scrollW} clientW=${m.home && m.home.clientW}`);

  check(m.cards.length === 4, `A[${tag}] 4 张模式卡存在`, 'count=' + m.cards.length);
  check(!!m.heroTitle, `A[${tag}] hero 标题存在`, m.heroTitle ? '五子棋' : 'missing');
  check(!!m.heroSub, `A[${tag}] 副标题存在`, m.heroSub ? '15×15 棋盘…' : 'missing');

  const allIn = m.cards.length === 4 && m.cards.every((c) =>
    c.top >= -1 && c.bottom <= m.vh + 1 && c.left >= -1 && c.right <= m.vw + 1);
  check(allIn, `A[${tag}] 4 卡全部在视口内`,
    JSON.stringify(m.cards.map((c) => [Math.round(c.top), Math.round(c.bottom)])));

  let overlap = false;
  for (let i = 0; i < m.cards.length; i++) {
    for (let j = i + 1; j < m.cards.length; j++) {
      const a = m.cards[i], b = m.cards[j];
      if (a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1) overlap = true;
    }
  }
  check(!overlap, `A[${tag}] 卡片两两不重叠`);

  const btnsOk = m.cards.length === 4 && m.cards.every((c) =>
    c.btns.length > 0 && c.btns.every((b) =>
      b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.top >= 0 && b.bottom <= m.vh + 1));
  check(btnsOk, `A[${tag}] 每卡按钮可见`,
    JSON.stringify(m.cards.map((c) => c.btns.length)));

  check(m.doc.scrollW <= m.doc.clientW + 1, `A[${tag}] 文档无横向溢出`,
    m.doc.scrollW + '≤' + m.doc.clientW);

  check(!!(m.home && m.home.lock), `A[${tag}] lockHomeScroll 已绑定(dataset.lockHome=1)`);

  await touchDrag(page, Math.round(m.vw / 2), 300, Math.round(m.vw / 2), 420);
  const m2 = await measureHome(page);
  check(m2.scrollY === 0, `A[${tag}] touch 下拉 120px 后 scrollY=0`, 'scrollY=' + m2.scrollY);

  await page.close();
}

/* ═══ B/C/D. 两态棋盘矩形 ═══ */
async function verifyDualRect(browser, vp) {
  const page = await newPage(browser, vp.w, vp.h);
  await gotoHome(page);
  await enterGame(page);
  const tag = vp.tag;
  const docked = await measureGame(page);

  check(!!(docked.dock && docked.dock.overlay), `${tag}[dock态] #ai-setup 为覆盖层(dock-overlay)`,
    docked.dock ? 'h=' + Math.round(docked.dock.h) + ' z=' + docked.dock.zIndex : 'none');
  check(docked.dockHVar > 0, `${tag}[dock态] --v128-dock-h 写入实测高`, docked.dockHVar + 'px');

  const b = docked.wrap;
  const c = docked.canvas;
  check(b && c && near(b.x, c.x, 0.5) && near(b.y, c.y, 0.5) && near(b.w, c.w, 0.5) && near(b.h, c.h, 0.5),
    `${tag}[dock态] board-wrap 与 canvas 矩形一致`,
    'wrap=' + JSON.stringify(b) + ' canvas=' + JSON.stringify(c));

  // 占满宽度断言：仅主视口 412×915（用户明确 w=412=屏宽）；极矮/小屏高度受限时
  // 边长=min(宽,高) < 412 属正确行为（不判占满，仅记录）
  if (vp.w === 412 && vp.h >= 900) {
    check(b && Math.abs(b.w - vp.w) <= 1, `${tag}[dock态] 棋盘占满宽度(${vp.w})`, b ? 'w=' + b.w : 'none');
    check(b && Math.abs((b.x + b.w / 2) - vp.w / 2) <= 2, `${tag}[dock态] 棋盘水平居中 cx=${vp.w / 2}`,
      b ? 'x=' + b.x.toFixed(1) : 'none');
  } else if (vp.w === 412 && vp.h < 900) {
    // 极矮：仅记录实际边长与可用区（不判占满）
    if (b && docked.boardScroll) {
      const availH = docked.vh - docked.boardScroll.padT - docked.boardScroll.padB;
      check(b.h <= availH + 1, `${tag}[dock态] 棋盘 ≤ 可用区无溢出`,
        'h=' + b.h + ' avail=' + availH.toFixed(1));
      console.log(`INFO ${tag}[dock态] 高度受限边长=${b.w}（非满宽，符合 min(宽,高) 语义）`);
    }
  }

  // 垂直居中（用户口径：topGap=board.y, bottomGap=innerHeight−board.bottom）
  if (b) {
    const topGap = b.y;
    const botGap = docked.vh - b.bottom;
    const diff = Math.abs(topGap - botGap);
    check(diff <= 8, `${tag}[dock态] 垂直居中于视口（用户口径）`,
      `topGap=${topGap.toFixed(1)} botGap=${botGap.toFixed(1)} Δ=${diff.toFixed(1)}`);
  }
  if (b && docked.boardScroll) {
    const innerTop = b.y - docked.boardScroll.padT;
    const innerBot = (docked.vh - docked.boardScroll.padB) - (b.y + b.h);
    console.log(`INFO ${tag}[dock态] margin:auto 内容区居中参考: top=${innerTop.toFixed(1)} bot=${innerBot.toFixed(1)} Δ=${Math.abs(innerTop - innerBot).toFixed(1)}`);
  }

  if (b && docked.dock) {
    const boardBottom = b.y + b.h;
    check(docked.dock.top >= boardBottom - 1, `${tag}[dock态] dock 顶缘 ≥ 棋盘底缘（不遮）`,
      `boardBottom=${Math.round(boardBottom)} dockTop=${Math.round(docked.dock.top)}`);
  }

  check(docked.boardScroll && docked.boardScroll.scrollW <= docked.boardScroll.clientW + 1,
    `${tag}[dock态] board-scroll 无横向滚动`,
    docked.boardScroll ? docked.boardScroll.scrollW + '≤' + docked.boardScroll.clientW : 'no-bs');
  check(docked.boardScroll && docked.boardScroll.scrollH <= docked.boardScroll.clientH + 1,
    `${tag}[dock态] board-scroll 无垂直滚动`,
    docked.boardScroll ? docked.boardScroll.scrollH + '≤' + docked.boardScroll.clientH : 'no-bs');
  check(docked.doc.scrollW <= docked.doc.clientW + 1, `${tag}[dock态] doc 无横向溢出`,
    docked.doc.scrollW + '≤' + docked.doc.clientW);

  // CDP 拖棋盘 120px → 位移 0
  const bc = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: vp.w / 2, y: 300 };
  await touchDrag(page, bc.x, bc.y, bc.x, bc.y + 120);
  const d1 = await measureGame(page);
  check(d1.scrollY === 0 && d1.boardScroll && d1.boardScroll.scrollTop === 0,
    `${tag}[dock态] 拖 120px 后 scrollY/scrollTop 恒 0`,
    'scrollY=' + d1.scrollY + ' bsTop=' + (d1.boardScroll && d1.boardScroll.scrollTop));
  check(d1.wrap && b && near(d1.wrap.x, b.x, 1) && near(d1.wrap.y, b.y, 1),
    `${tag}[dock态] 拖后棋盘 rect 不变`, JSON.stringify(d1.wrap));

  // ═══ 沉浸态 ═══
  await startGame(page);
  const imm = await measureGame(page);
  const bi = imm.wrap;
  check(imm.immersive, `${tag}[沉浸态] body.immersive 已置位`);
  check(imm.dockHVar > 0, `${tag}[沉浸态] --v128-dock-h 保留（两态同值）`, imm.dockHVar + 'px');

  const same = b && bi && near(b.x, bi.x, 0.5) && near(b.y, bi.y, 0.5) &&
    near(b.w, bi.w, 0.5) && near(b.h, bi.h, 0.5);
  check(!!same, `${tag} 两态棋盘 rect 全等（Δ=0）`,
    'dock=' + JSON.stringify(b) + ' imm=' + JSON.stringify(bi));

  if (vp.w === 412 && vp.h >= 900) {
    check(bi && Math.abs(bi.w - vp.w) <= 1, `${tag}[沉浸态] 棋盘占满宽度(${vp.w})`, bi ? 'w=' + bi.w : 'none');
    if (bi) {
      const topGap = bi.y, botGap = imm.vh - (bi.y + bi.h);
      const diff = Math.abs(topGap - botGap);
      check(diff <= 8, `${tag}[沉浸态] 垂直居中于视口（用户口径）`,
        `topGap=${topGap.toFixed(1)} botGap=${botGap.toFixed(1)} Δ=${diff.toFixed(1)}`);
    }
    if (bi && imm.boardScroll) {
      const topInner = bi.y - imm.boardScroll.padT;
      const botInner = (imm.vh - imm.boardScroll.padB) - (bi.y + bi.h);
      console.log(`INFO ${tag}[沉浸态] margin:auto 内容区居中参考: top=${topInner.toFixed(1)} bot=${botInner.toFixed(1)} Δ=${Math.abs(topInner - botInner).toFixed(1)}`);
    }
  }

  check(imm.boardScroll && imm.boardScroll.scrollW <= imm.boardScroll.clientW + 1 &&
    imm.boardScroll.scrollH <= imm.boardScroll.clientH + 1,
    `${tag}[沉浸态] board-scroll 零滚动`,
    imm.boardScroll ? imm.boardScroll.scrollW + '/' + imm.boardScroll.scrollH + ' ≤ ' + imm.boardScroll.clientW + '/' + imm.boardScroll.clientH : 'no-bs');

  const bic = bi ? { x: bi.x + bi.w / 2, y: bi.y + bi.h / 2 } : { x: vp.w / 2, y: 300 };
  await touchDrag(page, bic.x, bic.y, bic.x, bic.y + 120);
  const i1 = await measureGame(page);
  check(i1.scrollY === 0 && i1.boardScroll && i1.boardScroll.scrollTop === 0,
    `${tag}[沉浸态] 拖 120px 后 scrollY/scrollTop 恒 0`,
    'scrollY=' + i1.scrollY + ' bsTop=' + (i1.boardScroll && i1.boardScroll.scrollTop));

  await page.close();
  return { docked, imm };
}

/* ═══ E. 回归链路（412×915）═══ */
async function regressionChain(browser) {
  const page = await newPage(browser, 412, 915);
  await gotoHome(page);
  await enterGame(page);

  const st0 = await page.textContent('#game-status');
  check(st0.indexOf('等待开局') >= 0, 'E1 进对局未开局：状态=等待开局', st0);

  await page.click('#btn-floating-settings');
  await page.waitForTimeout(300);
  const dz = await page.evaluate(() => {
    const sp = document.querySelector('.side-panel');
    const dock = document.getElementById('ai-setup');
    const mask = document.getElementById('drawer-mask');
    return {
      open: sp.classList.contains('open'),
      spZ: parseInt(getComputedStyle(sp).zIndex, 10) || 0,
      dockZ: parseInt(getComputedStyle(dock).zIndex, 10) || 0,
      maskShow: mask.classList.contains('show'),
    };
  });
  check(dz.open && dz.maskShow, 'E2 抽屉可打开（侧栏 open + 遮罩 show）');
  check(dz.spZ > dz.dockZ, 'E3 侧栏 z 序盖过 dock', 'spZ=' + dz.spZ + ' > dockZ=' + dz.dockZ);
  await page.evaluate(() => document.getElementById('drawer-mask').click());
  await page.waitForTimeout(250);

  await startGame(page);
  const st1 = await page.textContent('#game-status');
  check(st1.indexOf('轮到你') >= 0, 'E4 开局后玩家先手：状态=轮到你', st1);

  const gm = await measureGame(page);
  const b = gm.wrap;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(120);
  const st2 = await page.textContent('#game-status');
  check(st2.indexOf('思考') >= 0, 'E5 落子被接受：状态进入 AI 思考', st2);

  // 等 AI 回手后画面定格，再采样天元黑子（采样 5×5 取最小亮度，避免格线/抗锯齿干扰）
  const replied = await page.waitForFunction(() => {
    const s = document.getElementById('game-status').textContent;
    return s.indexOf('思考') < 0 && (s.indexOf('轮到你') >= 0 || s.indexOf('获胜') >= 0 || s.indexOf('平局') >= 0);
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(replied, 'E7 AI 回手成功（回到玩家回合/终局）', await page.textContent('#game-status'));

  const px = await page.evaluate(() => {
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    // 天元逻辑坐标 = canvas.width/2（15×15 网格中心）
    const cx0 = Math.round(canvas.width / 2), cy0 = Math.round(canvas.height / 2);
    let minLum = 255, minAt = '';
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = ctx.getImageData(cx0 + dx, cy0 + dy, 1, 1).data;
        const lum = (d[0] + d[1] + d[2]) / 3;
        if (lum < minLum) { minLum = lum; minAt = (cx0 + dx) + ',' + (cy0 + dy); }
      }
    }
    return { minLum, minAt, cx0, cy0, cssW: canvas.getBoundingClientRect().width, logicalW: canvas.width };
  });
  check(px.minLum < 100, 'E6 天元出现黑子（5×5 最小亮度=' + px.minLum.toFixed(0) + '）', JSON.stringify(px));

  await page.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });

  // ═══ A. 大厅一屏：5 视口 ═══
  const VPS = [
    { w: 412, h: 915, tag: '412×915' },
    { w: 360, h: 640, tag: '360×640' },
    { w: 412, h: 568, tag: '412×568极矮' },
    { w: 320, h: 568, tag: '320×568' },
    { w: 844, h: 390, tag: '844×390横屏' },
  ];
  for (const vp of VPS) await verifyHome(browser, vp);

  // ═══ B/C/D. 两态棋盘：412×915（主）、360×640、412×568（极矮记录）═══
  await verifyDualRect(browser, { w: 412, h: 915, tag: '412×915' });
  await verifyDualRect(browser, { w: 360, h: 640, tag: '360×640' });
  await verifyDualRect(browser, { w: 412, h: 568, tag: '412×568极矮' });

  // ═══ E. 回归链路 ═══
  await regressionChain(browser);

  // ═══ F. 全程错误 ═══
  check(allPageErrors.length === 0, 'F 全程无 pageerror / console.error',
    allPageErrors.length ? allPageErrors.join(' | ').slice(0, 500) : '');

  await browser.close();
  const out = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    allPageErrors: allPageErrors,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('\n==== qa_verify-v128 汇总 ====');
  console.log('PASS ' + out.passed + ' / ' + out.total + (out.failed ? '  FAIL ' + out.failed : ''));
  process.exit(out.failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
