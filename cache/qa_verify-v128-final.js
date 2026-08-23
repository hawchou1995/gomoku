/* ════════════════════════════════════════════════════════════════════
   QA 最终复核 v1.2.8（Task #90 · P0 · 返修后终判）
   验证者：严守真（quality-lead）
   —— 上一轮独立验证抓到 FAIL（两态 Δ=0 达成但「视口居中」FAIL：
      y=122.5 / 底 gap 380.5，因沉浸态 padB=64+266 不对称）。
      主理人裁决：居中 = 用户目击的视口上下均衡（|topGap−bottomGap|≤8）。
      engineering-lead 已返修。本脚本按 v1.2.8 最终口径独立重写断言，
      不复用旧 qa_verify-v128.js 的废弃断言（沉浸 padB>64 / dock-h 保留等），
      亦不照抄 selftest-v128b.js（仅了解语义，断言独立编写）。

   复核矩阵：
     M1 两态全等 + 视口居中（核心，412×915）：rect Δ=0、w=412、|topGap−bottomGap|≤8、沉浸 y=255.5±2
     M2 dock 不遮棋盘（412×915 / 360×640 / 412×568）：dock 顶缘 ≥ 棋盘底缘；三主行在 915/640 可见；568 被 clamp 不遮即可
     M3 小屏两态一致（360×640）：rect 全等
     M4 零滚动零拖动：两态 CDP 拖 120px 位移 0；scrollW/H ≤ clientW/H
     M5 回归链路：大厅→对局→开局→落子→AI 回手 0 错；悬浮按钮在 dock 之上；抽屉 z 盖过 dock
     M6 全程 pageerror / console.error = 0
     M7 专项复核：沉浸态 padding-bottom=64（不含 dock-h）是新语义非 bug；旧断言不适用

   运行：
     NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
     C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/qa_verify-v128-final.js
   结果 JSON → cache/qa_verify-v128-final-result.json
   ════════════════════════════════════════════════════════════════════ */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, 'qa_verify-v128-final-result.json');

const results = [];
const pageErrors = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

async function newPage(browser, w, h) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    isMobile: true,
    hasTouch: true,
  });
  page.on('pageerror', (e) => pageErrors.push('pageerror:' + String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console:' + m.text()); });
  return page;
}

async function gotoHome(page) {
  await page.goto(BASE, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  await page.waitForFunction(() => document.getElementById('btn-enter-ai'), null, { timeout: 15000 });
  await page.waitForTimeout(500);
}

async function enterGame(page) {
  await page.click('#btn-enter-ai');
  await page.waitForFunction(() => {
    const v = document.getElementById('view-game');
    return v && !v.classList.contains('hidden') && !!document.querySelector('.board-wrap');
  }, null, { timeout: 6000 });
  await page.waitForTimeout(500); // 等 placeSetupDock 落位 + resizeBoard
}

async function startGame(page) {
  await page.evaluate(() => document.getElementById('btn-start-ai').click());
  await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 6000 });
  await page.waitForTimeout(550); // 等 setImmersive 后 placeSetupDock 移除 dock / HUD 稳定
}

async function touchDrag(page, x0, y0, x1, y1) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x1, y1) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(200);
}

/* ── 对局视图综合测量（只读，不触发动作）── */
async function measureGame(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY, scrollX: window.scrollX };
    const rectOf = (el) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right, bottom: r.bottom };
    };
    const wrap = document.querySelector('.board-wrap');
    out.board = rectOf(wrap);
    out.canvas = rectOf(document.getElementById('board'));
    const bs = document.querySelector('.board-scroll');
    if (bs) {
      const cs = getComputedStyle(bs);
      out.bs = {
        padT: parseFloat(cs.paddingTop) || 0,
        padB: parseFloat(cs.paddingBottom) || 0,
        clientW: bs.clientWidth, scrollW: bs.scrollWidth,
        clientH: bs.clientHeight, scrollH: bs.scrollHeight,
        scrollTop: bs.scrollTop, scrollLeft: bs.scrollLeft,
        touchAction: cs.touchAction,
        lock: bs.dataset.lockBoard === '1',
      };
    }
    // dock：仅当覆盖层在场时测量（沉浸态被移除 → null）
    const setup = document.getElementById('ai-setup');
    if (setup && setup.classList.contains('dock-overlay')) {
      const dr = setup.getBoundingClientRect();
      const dcs = getComputedStyle(setup);
      out.dock = {
        top: dr.top, bottom: dr.bottom, left: dr.left, right: dr.right, w: dr.width, h: dr.height,
        overlay: true, position: dcs.position, zIndex: parseInt(dcs.zIndex, 10) || 0,
        maxHeight: parseFloat(dcs.maxHeight) || 0,
      };
    } else {
      out.dock = null;
    }
    out.dockHVar = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--v128-dock-h')) || 0;
    out.immersive = document.body.classList.contains('immersive');
    const fab = document.getElementById('btn-floating-settings');
    if (fab) {
      const fr = fab.getBoundingClientRect();
      out.fab = {
        top: fr.top, bottom: fr.bottom,
        visible: getComputedStyle(fab).display !== 'none' && fr.width > 0,
      };
    }
    out.status = (document.getElementById('game-status') || {}).textContent || '';
    const sp = document.querySelector('.side-panel');
    const mask = document.getElementById('drawer-mask');
    out.drawer = {
      open: !!sp && sp.classList.contains('open'),
      maskShow: !!mask && mask.classList.contains('show'),
      spZ: sp ? parseInt(getComputedStyle(sp).zIndex, 10) || 0 : 0,
      dockZ: setup ? parseInt(getComputedStyle(setup).zIndex, 10) || 0 : 0,
      maskZ: mask ? parseInt(getComputedStyle(mask).zIndex, 10) || 0 : 0,
    };
    out.doc = {
      scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
      scrollH: document.documentElement.scrollHeight, clientH: document.documentElement.clientHeight,
    };
    return out;
  });
}

/* 三主行可见性（仅 dock 在场时调用）：段位 / 开关 / 开始按钮 */
async function dockRowsVisible(page) {
  return page.evaluate(() => {
    const dock = document.getElementById('ai-setup');
    if (!dock || !dock.classList.contains('dock-overlay')) return { found: false };
    const dr = dock.getBoundingClientRect();
    const sels = ['.setup-level-row', '.toggles', '#btn-start-ai'];
    const rows = sels.map((sel) => {
      const el = dock.querySelector(sel);
      if (!el) return { sel, found: false };
      const r = el.getBoundingClientRect();
      return { sel, found: true, top: r.top, bottom: r.bottom, h: r.height };
    });
    const allInside = rows.every((r) =>
      r.found && r.h > 0 && r.top >= dr.top - 1 && r.bottom <= dr.bottom + 1);
    return { found: true, allInside, rows, dockTop: dr.top, dockBottom: dr.bottom };
  });
}

/* ═══ M1 核心：412×915 两态全等 + 视口居中 ═══ */
async function m1DualCenter(browser) {
  const page = await newPage(browser, 412, 915);
  await gotoHome(page);
  await enterGame(page);
  const tag = 'M1';

  const d = await measureGame(page);
  const b = d.board;
  check(!!d.dock, `${tag}1 非沉浸：dock 覆盖层存在（dock-overlay）`,
    d.dock ? 'h=' + d.dock.h.toFixed(1) + ' z=' + d.dock.zIndex : 'none');
  check(d.dock && d.dock.position === 'fixed' && d.dock.zIndex === 54,
    `${tag}2 非沉浸：dock 为 fixed 贴底覆盖层 z=54`,
    d.dock ? d.dock.position + '/' + d.dock.zIndex : 'no-dock');
  check(d.dockHVar > 0, `${tag}3 非沉浸：--v128-dock-h 已写入实测高`, d.dockHVar + 'px');
  check(near(d.bs.padT, 72, 0.5), `${tag}4 非沉浸：board-scroll padding-top=72`, 'padT=' + d.bs.padT.toFixed(1));
  // 专项复核：padB=64 不含 dock-h（v1.2.8 新语义，非 bug）
  check(near(d.bs.padB, 64, 0.5), `${tag}5 非沉浸：padding-bottom=64（不含 dock 预留，新语义）`,
    'padB=' + d.bs.padB.toFixed(1) + ' dockHVar=' + d.dockHVar.toFixed(1));
  check(b && Math.abs(b.w - 412) <= 1, `${tag}6 非沉浸：棋盘占满宽 412`, b ? 'w=' + b.w : 'none');
  check(b && Math.abs(b.x) <= 1, `${tag}7 非沉浸：棋盘贴左 x=0`, b ? 'x=' + b.x.toFixed(1) : 'none');
  check(b && Math.abs(b.h - 412) <= 1, `${tag}8 非沉浸：棋盘边长 412`, b ? 'h=' + b.h : 'none');
  if (b) {
    const topGap = b.y, botGap = d.vh - b.bottom;
    const diff = Math.abs(topGap - botGap);
    check(diff <= 8, `${tag}9 非沉浸：视口上下留白均衡 |top−bottom|≤8`,
      `topGap=${topGap.toFixed(1)} botGap=${botGap.toFixed(1)} Δ=${diff.toFixed(1)}`);
  }
  if (b && d.dock) {
    check(d.dock.top >= b.bottom - 0.01, `${tag}10 非沉浸：dock 顶缘 ≥ 棋盘底缘（不遮）`,
      `boardBottom=${b.bottom.toFixed(1)} dockTop=${d.dock.top.toFixed(1)}`);
  }

  // M4a 非沉浸零滚动 + 拖动位移 0
  check(d.bs && d.bs.scrollW <= d.bs.clientW + 1, `${tag}11 非沉浸：board-scroll 无横向滚动`,
    d.bs ? d.bs.scrollW + '≤' + d.bs.clientW : 'no-bs');
  check(d.bs && d.bs.scrollH <= d.bs.clientH + 1, `${tag}12 非沉浸：board-scroll 无垂直滚动`,
    d.bs ? d.bs.scrollH + '≤' + d.bs.clientH : 'no-bs');
  check(d.doc.scrollW <= d.doc.clientW + 1, `${tag}13 非沉浸：文档无横向溢出`,
    d.doc.scrollW + '≤' + d.doc.clientW);
  const bc = b ? { x: b.x + b.w / 2, y: b.y + b.h / 2 } : { x: 206, y: 460 };
  await touchDrag(page, bc.x, bc.y, bc.x, bc.y + 120);
  const d1 = await measureGame(page);
  check(d1.scrollY === 0 && d1.bs.scrollTop === 0, `${tag}14 非沉浸：CDP 拖 120px 后 scrollY/scrollTop 恒 0`,
    'scrollY=' + d1.scrollY + ' bsTop=' + d1.bs.scrollTop);
  check(d1.board && b && near(d1.board.x, b.x, 1) && near(d1.board.y, b.y, 1),
    `${tag}15 非沉浸：拖后棋盘 rect 不变`, JSON.stringify(d1.board));

  // ══ 沉浸态 ══
  await startGame(page);
  const im = await measureGame(page);
  const bi = im.board;
  check(im.immersive, `${tag}16 沉浸：body.immersive 已置位`);
  check(im.dock === null, `${tag}17 沉浸：dock 覆盖层已移除（回抽屉）`,
    im.dock ? 'still-dock' : 'removed');
  check(im.dockHVar === 0, `${tag}18 沉浸：--v128-dock-h 已移除（旧断言「保留」不再适用）`,
    'dockHVar=' + im.dockHVar);
  check(near(im.bs.padT, 72, 0.5), `${tag}19 沉浸：padding-top=72（与 HUD 顶区同预算）`, 'padT=' + im.bs.padT.toFixed(1));
  check(near(im.bs.padB, 64, 0.5), `${tag}20 沉浸：padding-bottom=64（不含 dock-h，新语义非 bug）`,
    'padB=' + im.bs.padB.toFixed(1));
  const same = b && bi && near(b.x, bi.x, 0.5) && near(b.y, bi.y, 0.5) &&
    near(b.w, bi.w, 0.5) && near(b.h, bi.h, 0.5);
  check(!!same, `${tag}21 两态棋盘 rect 全等（Δ=0）`,
    'dock=' + JSON.stringify(b) + ' imm=' + JSON.stringify(bi));
  check(bi && Math.abs(bi.w - 412) <= 1, `${tag}22 沉浸：棋盘占满宽 412`, bi ? 'w=' + bi.w : 'none');
  check(bi && near(bi.y, 255.5, 2), `${tag}23 沉浸：棋盘 y=255.5±2（居中回归）`,
    bi ? 'y=' + bi.y.toFixed(1) : 'none');
  if (bi) {
    const topGap = bi.y, botGap = im.vh - bi.bottom;
    check(Math.abs(topGap - botGap) <= 8, `${tag}24 沉浸：视口上下留白均衡 ≤8`,
      `topGap=${topGap.toFixed(1)} botGap=${botGap.toFixed(1)} Δ=${Math.abs(topGap - botGap).toFixed(1)}`);
  }
  check(im.bs && im.bs.scrollW <= im.bs.clientW + 1 && im.bs.scrollH <= im.bs.clientH + 1,
    `${tag}25 沉浸：board-scroll 零滚动`,
    im.bs ? im.bs.scrollW + '/' + im.bs.scrollH + ' ≤ ' + im.bs.clientW + '/' + im.bs.clientH : 'no-bs');
  const bic = bi ? { x: bi.x + bi.w / 2, y: bi.y + bi.h / 2 } : { x: 206, y: 460 };
  await touchDrag(page, bic.x, bic.y, bic.x, bic.y + 120);
  const i1 = await measureGame(page);
  check(i1.scrollY === 0 && i1.bs.scrollTop === 0, `${tag}26 沉浸：CDP 拖 120px 后 scrollY/scrollTop 恒 0`,
    'scrollY=' + i1.scrollY + ' bsTop=' + i1.bs.scrollTop);
  check(i1.board && near(i1.board.x, bi.x, 1) && near(i1.board.y, bi.y, 1),
    `${tag}27 沉浸：拖后棋盘 rect 不变`, JSON.stringify(i1.board));

  await page.close();
  return { docked: d, imm: im };
}

/* ═══ M2: dock 不遮棋盘（三视口） ═══ */
async function m2DockNoCover(browser) {
  for (const vp of [
    { w: 412, h: 915, tag: '412×915' },
    { w: 360, h: 640, tag: '360×640' },
    { w: 412, h: 568, tag: '412×568' },
  ]) {
    const page = await newPage(browser, vp.w, vp.h);
    await gotoHome(page);
    await enterGame(page);
    const m = await measureGame(page);
    const b = m.board, dock = m.dock;
    check(!!(dock && dock.overlay), `M2[${vp.tag}] dock 覆盖层存在`,
      dock ? 'h=' + dock.h.toFixed(1) : 'none');
    check(!!(dock && b && dock.top >= b.bottom - 0.01), `M2[${vp.tag}] dock 顶缘 ≥ 棋盘底缘（不遮）`,
      'boardBottom=' + (b ? b.bottom.toFixed(1) : '-') + ' dockTop=' + (dock ? dock.top.toFixed(1) : '-'));
    check(!!(dock && dock.top >= 0 && dock.bottom <= vp.h + 1), `M2[${vp.tag}] dock 覆盖层在视口内`,
      dock ? 'top=' + dock.top.toFixed(1) + ' bottom=' + dock.bottom.toFixed(1) : 'no-dock');
    check(near(m.dockHVar, dock ? dock.h : 0, 1.5), `M2[${vp.tag}] --v128-dock-h 与实测 dock 高一致`,
      'var=' + m.dockHVar.toFixed(1) + ' rect=' + (dock ? dock.h.toFixed(1) : '-'));
    check(m.bs && m.bs.scrollW <= m.bs.clientW + 1 && m.bs.scrollH <= m.bs.clientH + 1,
      `M2[${vp.tag}] board-scroll 零滚动`,
      m.bs ? m.bs.scrollW + '/' + m.bs.scrollH + ' ≤ ' + m.bs.clientW + '/' + m.bs.clientH : 'no-bs');
    check(m.doc.scrollW <= m.doc.clientW + 1, `M2[${vp.tag}] 文档无横向溢出`,
      m.doc.scrollW + '≤' + m.doc.clientW);
    // 三主行可见：仅 915/640 要求；412×568 允许 clamp/截断（只判不遮）
    if (vp.h >= 640) {
      const rows = await dockRowsVisible(page);
      check(rows.found && rows.allInside, `M2[${vp.tag}] 三主行（段位/开关/开始）完整可见`,
        rows.found ? rows.rows.map((r) => r.sel + ':' + Math.round(r.h)).join(' ') : 'no-dock');
    } else {
      check(!!(dock && dock.h <= vp.h - b.bottom + 0.5), `M2[${vp.tag}] dock 被 clamp 至棋盘底净空`,
        'dockH=' + (dock ? dock.h.toFixed(1) : '-') + ' clearBelow=' + (b ? (vp.h - b.bottom).toFixed(1) : '-'));
    }
    await page.close();
  }
}

/* ═══ M3: 360×640 两态一致 ═══ */
async function m3SmallDual(browser) {
  const page = await newPage(browser, 360, 640);
  await gotoHome(page);
  await enterGame(page);
  const d = await measureGame(page);
  const b = d.board;
  check(b && b.w <= 360 + 1 && b.h <= 640 - d.bs.padT - d.bs.padB + 1, 'M3 非沉浸：棋盘在可用区内',
    b ? JSON.stringify(b) + ' avail=' + (640 - d.bs.padT - d.bs.padB) : 'none');
  await startGame(page);
  const im = await measureGame(page);
  const bi = im.board;
  const same = b && bi && near(b.x, bi.x, 0.5) && near(b.y, bi.y, 0.5) &&
    near(b.w, bi.w, 0.5) && near(b.h, bi.h, 0.5);
  check(!!same, 'M3 360×640 两态棋盘 rect 全等（Δ=0）',
    'dock=' + JSON.stringify(b) + ' imm=' + JSON.stringify(bi));
  check(im.dock === null && im.dockHVar === 0, 'M3 沉浸：dock 移除 + dock-h 清零',
    'dockHVar=' + im.dockHVar);
  await page.close();
}

/* ═══ M5: 回归链路（412×915） ═══ */
async function m5Regression(browser) {
  const page = await newPage(browser, 412, 915);
  await gotoHome(page);
  await enterGame(page);

  const st0 = await page.textContent('#game-status');
  check(st0.indexOf('等待开局') >= 0, 'M5a 进对局未开局：状态=等待开局', st0);

  const m0 = await measureGame(page);
  check(m0.fab && m0.fab.visible, 'M5b 悬浮「设置」按钮可见（非沉浸）',
    m0.fab ? 'top=' + m0.fab.top.toFixed(1) + ' bottom=' + m0.fab.bottom.toFixed(1) : 'none');
  check(m0.fab && m0.dock && m0.fab.bottom <= m0.dock.top + 0.01,
    'M5c 悬浮按钮在 dock 之上（bottom 避让 dock）',
    'fabBottom=' + (m0.fab ? m0.fab.bottom.toFixed(1) : '-') + ' dockTop=' + (m0.dock ? m0.dock.top.toFixed(1) : '-'));

  await page.click('#btn-floating-settings');
  await page.waitForTimeout(350);
  const dz = await measureGame(page);
  check(dz.drawer.open && dz.drawer.maskShow, 'M5d 抽屉可打开（open + 遮罩 show）');
  check(dz.drawer.spZ > dz.drawer.dockZ && dz.drawer.maskZ > dz.drawer.dockZ,
    'M5e 抽屉/遮罩 z 序盖过 dock（56/55 > 54）',
    'spZ=' + dz.drawer.spZ + ' maskZ=' + dz.drawer.maskZ + ' dockZ=' + dz.drawer.dockZ);
  await page.evaluate(() => document.getElementById('drawer-mask').click());
  await page.waitForTimeout(300);
  const dz2 = await measureGame(page);
  check(!dz2.drawer.open && !dz2.drawer.maskShow, 'M5f 抽屉可关闭（遮罩点击）');

  await startGame(page);
  const st1 = await page.textContent('#game-status');
  check(st1.indexOf('轮到你') >= 0, 'M5g 开局后玩家先手：状态=轮到你', st1);

  const gm = await measureGame(page);
  const b = gm.board;
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(120);
  const st2 = await page.textContent('#game-status');
  check(st2.indexOf('思考') >= 0, 'M5h 落子被接受：状态进入 AI 思考', st2);

  // 等 AI 回手，画面定格后采样天元黑子（5×5 最小亮度，抗锯齿/格线免疫）
  const replied = await page.waitForFunction(() => {
    const s = document.getElementById('game-status').textContent;
    return s.indexOf('思考') < 0 && (s.indexOf('轮到你') >= 0 || s.indexOf('获胜') >= 0 || s.indexOf('平局') >= 0);
  }, null, { timeout: 15000 }).then(() => true).catch(() => false);
  check(replied, 'M5i AI 回手成功（离开「AI 思考」）', await page.textContent('#game-status'));

  const px = await page.evaluate(() => {
    const canvas = document.getElementById('board');
    const ctx = canvas.getContext('2d');
    const cx0 = Math.round(canvas.width / 2), cy0 = Math.round(canvas.height / 2);
    let minLum = 255, minAt = '';
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        const d = ctx.getImageData(cx0 + dx, cy0 + dy, 1, 1).data;
        const lum = (d[0] + d[1] + d[2]) / 3;
        if (lum < minLum) { minLum = lum; minAt = (cx0 + dx) + ',' + (cy0 + dy); }
      }
    }
    return { minLum, minAt, cssW: canvas.getBoundingClientRect().width, logicalW: canvas.width };
  });
  check(px.minLum < 100, 'M5j 天元出现黑子（5×5 最小亮度=' + px.minLum.toFixed(0) + '）', JSON.stringify(px));

  await page.close();
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });

  await m1DualCenter(browser);   // M1 + M4（412×915 两态）
  await m2DockNoCover(browser);  // M2
  await m3SmallDual(browser);    // M3
  await m5Regression(browser);   // M5

  check(pageErrors.length === 0, 'M6 全程无 pageerror / console.error',
    pageErrors.length ? pageErrors.join(' | ').slice(0, 500) : '');

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  const out = {
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    allPageErrors: pageErrors,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2));
  console.log('\n==== qa_verify-v128-final 汇总 ====');
  console.log('PASS ' + passed + ' / ' + results.length + (failed ? '  FAIL ' + failed : ''));
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
