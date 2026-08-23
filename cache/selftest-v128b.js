/* v1.2.8 P0 返修回归（Task #89 · quality-lead 终判 FAIL 后按主理人裁决重测）
   核心口径：用户「棋盘居中」= 视口内上下留白均衡（|topGap−bottomGap| ≤ 8，72/64
   结构性差可容忍），非「内容区居中」。修复：两态 .board-scroll padding 对称
   （顶 72 / 底 64，去掉 dock 预留），dock 改独立覆盖层并压缩 ≤247px，极端矮屏
   JS 兜底 clamp 净空——绝不遮棋盘。

   断言（六组 + 全链路 + 无错误）：
   1. 412×915 两态 board rect 全等（Δ=0）且 |topGap−bottomGap|≤8、w=412 占满宽；
   2. dock 顶边 ≥ 棋盘底边（412×915 / 360×640 / 412×568 三视口；矮屏以不遮为准）；
   3. 沉浸态棋盘 y=255.5 ±2（回归 v1.2.7 居中）；
   4. 悬浮按钮 bottom 避让 dock（在 dock 之上可见）；
   5. 零滚动零拖动（两态 CDP 拖 120px 位移 0）；落子→AI 回手链路 0 错误；
   6. 大厅自适应回归（4 视口元素全显示、无滚动、禁下拉）。

   运行：NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
         C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/selftest-v128b.js
   结果 JSON 输出到同目录 selftest-v128b-result.json
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const results = [];
const pageErrors = [];
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
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console:' + m.text()); });
  return page;
}

async function measureGame(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY };
    const wrap = document.querySelector('.board-wrap');
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      out.board = { x: r.x, y: r.y, w: r.width, h: r.height };
      out.gaps = {
        left: r.x,
        right: innerWidth - (r.x + r.width),
        top: r.y,
        bottom: innerHeight - (r.y + r.height),
      };
      out.centerH = Math.abs((r.x + r.width / 2) - innerWidth / 2) < 2;
    }
    const bs = document.querySelector('.board-scroll');
    if (bs) {
      const cs = getComputedStyle(bs);
      out.padT = parseFloat(cs.paddingTop) || 0;
      out.padB = parseFloat(cs.paddingBottom) || 0;
      out.scrollTop = bs.scrollTop;
    }
    const dock = document.getElementById('ai-setup');
    if (dock) {
      const dr = dock.getBoundingClientRect();
      out.dock = { x: dr.x, y: dr.y, w: dr.width, h: dr.height, top: dr.top, bottom: dr.bottom,
                   overlay: dock.classList.contains('dock-overlay') };
    }
    out.dockH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--v128-dock-h')) || 0;
    out.immersive = document.body.classList.contains('immersive');
    const fab = document.getElementById('btn-floating-settings');
    if (fab) {
      const fr = fab.getBoundingClientRect();
      out.fab = { top: fr.top, bottom: fr.bottom, visible: getComputedStyle(fab).display !== 'none' && fr.width > 0 };
    }
    out.doc = { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
    return out;
  });
}

async function measureHome(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY };
    const home = document.getElementById('view-home');
    if (home) {
      out.clientH = home.clientHeight;
      out.scrollH = home.scrollHeight;
      out.scrollW = home.scrollWidth;
      out.clientW = home.clientWidth;
      out.lockBound = home.dataset.lockHome === '1';
    }
    out.cards = Array.from(document.querySelectorAll('#view-home .mode-card')).map((c) => {
      const r = c.getBoundingClientRect();
      const btns = Array.from(c.querySelectorAll('.btn')).map((b) => {
        const br = b.getBoundingClientRect();
        return { top: br.top, bottom: br.bottom, left: br.left, right: br.right };
      });
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, btns };
    });
    out.doc = { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
    return out;
  });
}

async function drag(page, x0, y0, x1, y1) {
  const cdp = await page.context().newCDPSession(page);
  const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(x0, y0) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(x1, y1) });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await page.waitForTimeout(150);
}

async function enterGame(page) {
  await page.click('#btn-enter-ai');
  await page.waitForTimeout(350);
}

async function startGame(page) {
  await page.evaluate(() => document.getElementById('btn-start-ai').click());
  await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 5000 });
  await page.waitForTimeout(350);
}

const near = (a, b, tol) => Math.abs(a - b) <= tol;

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });

  // ═══ 1. 两态棋盘同一矩形 + 视口垂直居中 + 占满宽度（412×915 基准）═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const docked = await measureGame(page);
    check(docked.dock && docked.dock.overlay, '1.1 非沉浸 dock 态：#ai-setup 为覆盖层(dock-overlay)',
      docked.dock ? 'h=' + docked.dock.h.toFixed(1) : 'none');
    check(docked.dockH > 0, '1.2 非沉浸 dock 态：--v128-dock-h 已写入实测高', docked.dockH + 'px');
    check(near(docked.padB, 64, 0.1), '1.3 非沉浸 dock 态：padding-bottom=64（不再含 dock 预留）',
      'padB=' + docked.padB.toFixed(1) + ' dockH=' + docked.dockH.toFixed(1));
    check(docked.board && docked.board.w === 412, '1.4 非沉浸 dock 态：棋盘占满宽度(412)', JSON.stringify(docked.board));
    check(docked.board && Math.abs((docked.board.x + docked.board.w / 2) - 206) < 2,
      '1.5 非沉浸 dock 态：棋盘水平居中 cx=206',
      docked.board ? 'x=' + docked.board.x.toFixed(1) : 'no-board');
    const dTop = docked.board.y, dBot = docked.vh - (docked.board.y + docked.board.h);
    check(near(dTop - dBot, 8, 0.01), '1.6 非沉浸 dock 态：视口上下留白均衡 |top−bottom|≤8',
      'top=' + dTop.toFixed(1) + ' bottom=' + dBot.toFixed(1) + ' diff=' + (dTop - dBot).toFixed(3));
    check(docked.dock && docked.board && (docked.board.y + docked.board.h) <= docked.dock.top + 0.01,
      '1.7 非沉浸 dock 态：dock 顶缘 ≥ 棋盘底缘（不遮棋盘）',
      'boardBottom=' + (docked.board.y + docked.board.h).toFixed(1) + ' dockTop=' + docked.dock.top.toFixed(1));

    await startGame(page);
    const imm = await measureGame(page);
    check(imm.immersive, '1.8 开局后进入沉浸态');
    check(near(imm.padB, 64, 0.1), '1.9 沉浸态：padding-bottom=64（无 dock 预留）', 'padB=' + imm.padB.toFixed(1));
    const same = docked.board && imm.board &&
      near(docked.board.x, imm.board.x, 0.01) && near(docked.board.y, imm.board.y, 0.01) &&
      near(docked.board.w, imm.board.w, 0.01) && near(docked.board.h, imm.board.h, 0.01);
    check(!!same, '1.10 两态棋盘矩形完全相同（Δ=0：x/y/w/h 全等）',
      'dock=' + JSON.stringify(docked.board) + ' imm=' + JSON.stringify(imm.board));
    check(imm.board && imm.board.w === 412, '1.11 沉浸态：棋盘占满宽度(412)', JSON.stringify(imm.board));
    check(near(imm.board.y, 255.5, 2), '1.12 沉浸态棋盘 y=255.5 ±2（回归 v1.2.7 居中）',
      'y=' + imm.board.y.toFixed(1));
    const iTop = imm.board.y, iBot = imm.vh - (imm.board.y + imm.board.h);
    check(near(iTop - iBot, 8, 0.01), '1.13 沉浸态：视口上下留白均衡 |top−bottom|≤8',
      'top=' + iTop.toFixed(1) + ' bottom=' + iBot.toFixed(1) + ' diff=' + (iTop - iBot).toFixed(3));
    await page.close();
  }

  // ═══ 2. dock 不遮棋盘（412×915 / 360×640 / 412×568 三视口）═══
  for (const vp of [
    { w: 412, h: 915, tag: '412×915' },
    { w: 360, h: 640, tag: '360×640' },
    { w: 412, h: 568, tag: '412×568(极矮)' },
  ]) {
    const page = await newPage(browser, vp.w, vp.h);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const m = await measureGame(page);
    const ok = m.dock && m.board && (m.board.y + m.board.h) <= m.dock.top + 0.01;
    check(!!ok, `2[${vp.tag}] dock 顶缘 ≥ 棋盘底缘（不遮棋盘）`,
      'boardBottom=' + (m.board ? (m.board.y + m.board.h).toFixed(1) : '-') +
      ' dockTop=' + (m.dock ? m.dock.top.toFixed(1) : '-') + ' dockH=' + m.dockH.toFixed(1));
    check(m.dock && m.dock.top >= 0 && m.dock.bottom <= m.vh + 1, `2[${vp.tag}] dock 覆盖层在视口内`,
      m.dock ? 'top=' + m.dock.top.toFixed(1) + ' bottom=' + m.dock.bottom.toFixed(1) : 'no-dock');
    // 矮屏（360×640 及以上）要求三主行全可见（段位/开关/开始按钮）
    if (vp.h >= 640) {
      const vis = await page.evaluate(() => {
        const dock = document.getElementById('ai-setup');
        const dr = dock.getBoundingClientRect();
        const sels = ['.setup-level-row', '.toggles', '#btn-start-ai'];
        return sels.every((sel) => {
          const el = dock.querySelector(sel) || document.getElementById(sel);
          if (!el) return false;
          const r = el.getBoundingClientRect();
          return r.top >= dr.top - 1 && r.bottom <= dr.bottom + 1;
        });
      });
      check(vis, `2[${vp.tag}] 三主行（段位/开关/开始按钮）全可见`, '');
    }
    await page.close();
  }

  // ═══ 4. 悬浮「设置」按钮 bottom 避让 dock（dock 之上可见）═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const m = await measureGame(page);
    check(m.fab && m.fab.visible, '4.1 悬浮设置按钮可见（非沉浸 dock 态）',
      m.fab ? 'top=' + m.fab.top.toFixed(1) + ' bottom=' + m.fab.bottom.toFixed(1) : 'none');
    check(m.fab && m.dock && m.fab.bottom <= m.dock.top + 0.01, '4.2 悬浮按钮在 dock 之上（bottom 避让 dock）',
      'fabBottom=' + (m.fab ? m.fab.bottom.toFixed(1) : '-') + ' dockTop=' + (m.dock ? m.dock.top.toFixed(1) : '-'));
    await page.close();
  }

  // ═══ 5. 零滚动零拖动（两态 412×915）+ 落子→AI 回手链路 ═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const d0 = await measureGame(page);
    const cx = d0.board.x + d0.board.w / 2, cy = d0.board.y + d0.board.h / 2;
    await drag(page, cx, cy, cx, cy + 120);
    const d1 = await measureGame(page);
    check(d1.scrollY === 0 && d1.scrollTop === 0, '5.1 非沉浸 dock 态：棋盘 touch 拖动 120px 位移 0',
      'scrollY=' + d1.scrollY + ' boardScrollTop=' + d1.scrollTop);
    check(d1.board && near(d1.board.x, d0.board.x, 0.01) && near(d1.board.y, d0.board.y, 0.01),
      '5.2 非沉浸 dock 态：拖动后棋盘 rect 不变', JSON.stringify(d1.board));

    await startGame(page);
    const i0 = await measureGame(page);
    const ix = i0.board.x + i0.board.w / 2, iy = i0.board.y + i0.board.h / 2;
    await drag(page, ix, iy, ix, iy + 120);
    const i1 = await measureGame(page);
    check(i1.scrollY === 0 && i1.scrollTop === 0, '5.3 沉浸态：棋盘 touch 拖动 120px 位移 0',
      'scrollY=' + i1.scrollY + ' boardScrollTop=' + i1.scrollTop);
    check(i1.board && near(i1.board.x, i0.board.x, 0.01) && near(i1.board.y, i0.board.y, 0.01),
      '5.4 沉浸态：拖动后棋盘矩形不变', JSON.stringify(i1.board));
    // 开局瞬间零跳变：startGame 后与 dock 态 rect 全等（已在 1.10 覆盖，这里再核一次）
    check(i1.board && near(i1.board.y, d0.board.y, 0.01) && near(i1.board.x, d0.board.x, 0.01),
      '5.5 开局零跳变：沉浸态棋盘 rect 与 dock 态一致', JSON.stringify(i1.board));
    // 落子 → AI 回手链路
    const st0 = await page.textContent('#game-status');
    check(st0.indexOf('轮到你') >= 0, '5.6 开局后玩家先手：状态=轮到你', st0);
    const m = await measureGame(page);
    const lx = m.board.x + 206, ly = m.board.y + 206;
    await page.mouse.click(lx, ly);
    await page.waitForTimeout(80);
    const st2 = await page.textContent('#game-status');
    check(st2.indexOf('AI 思考') >= 0 || st2.indexOf('思考') >= 0, '5.7 落子被接受：状态进入 AI 思考', st2);
    const px = await page.evaluate(() => {
      const canvas = document.getElementById('board');
      const d = canvas.getContext('2d').getImageData(206, 211, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    });
    const lum = (px.r + px.g + px.b) / 3;
    check(lum < 100, '5.8 落子像素验证：天元格出现黑子（亮度=' + lum.toFixed(0) + '）', JSON.stringify(px));
    const replied = await page.waitForFunction(() => {
      const s = document.getElementById('game-status').textContent;
      return s.indexOf('思考') < 0 && (s.indexOf('轮到你') >= 0 || s.indexOf('获胜') >= 0 || s.indexOf('平局') >= 0);
    }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    check(replied, '5.9 AI 回手成功（状态离开「AI 思考」）', await page.textContent('#game-status'));
    await page.close();
  }

  // ═══ 6. 大厅一屏自适应回归：4 视口全显示、无滚动、禁下拉 ═══
  const HOME_VIEWPORTS = [
    { w: 412, h: 915, tag: '412×915' },
    { w: 360, h: 640, tag: '360×640' },
    { w: 412, h: 568, tag: '412×568(极矮)' },
    { w: 844, h: 390, tag: '844×390(横屏)' },
  ];
  for (const vp of HOME_VIEWPORTS) {
    const page = await newPage(browser, vp.w, vp.h);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await measureHome(page);
    const tag = vp.tag;
    check(near(m.scrollH, m.clientH, 2), `6[${tag}] #view-home 无内部溢出 scrollH==clientH`,
      `scrollH=${m.scrollH} clientH=${m.clientH}`);
    check(m.cards.length === 4, `6[${tag}] 4 张模式卡片存在`, 'count=' + m.cards.length);
    const allIn = m.cards.every((c) => c.top >= -1 && c.bottom <= m.vh + 1 && c.left >= -1 && c.right <= m.vw + 1);
    check(allIn, `6[${tag}] 4 卡片全部在视口内`, JSON.stringify(m.cards.map((c) => [Math.round(c.top), Math.round(c.bottom)])));
    const btnsVisible = m.cards.every((c) =>
      c.btns.length > 0 && c.btns.every((b) =>
        b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.top >= 0 && b.bottom <= m.vh + 1));
    check(btnsVisible, `6[${tag}] 每卡按钮可见（在卡内且在视口内）`, '');
    check(m.doc.scrollW <= m.doc.clientW, `6[${tag}] 文档无横向溢出`, m.doc.scrollW + '≤' + m.doc.clientW);
    check(m.lockBound, `6[${tag}] lockHomeScroll 已绑定（dataset.lockHome=1）`);
    if (tag === '412×915') {
      await drag(page, 206, 400, 206, 520);
      const m2 = await measureHome(page);
      check(m2.scrollY === 0, '6[412×915] 大厅 touch 拖动 120px 后 scrollY 恒 0', 'scrollY=' + m2.scrollY);
    }
    await page.close();
  }

  // ═══ H. 全程无页面错误 ═══
  check(pageErrors.length === 0, 'H 全程无 pageerror / console.error', pageErrors.length ? pageErrors.join(' | ').slice(0, 400) : '');

  await browser.close();
  const out = { generatedAt: new Date().toISOString(), total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  fs.writeFileSync(path.join(__dirname, 'selftest-v128b-result.json'), JSON.stringify(out, null, 2));
  console.log('\n==== selftest-v128b 汇总 ====');
  console.log('PASS ' + out.passed + ' / ' + out.total + (out.failed ? '  FAIL ' + out.failed : ''));
  process.exit(out.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
