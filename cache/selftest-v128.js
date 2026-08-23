/* v1.2.8 工程自测（Task #89，P0）
   两处修复：
   A. 大厅一屏自适应（用户反馈「显示的元素不全」）——任何视口 4 卡全可见、无滚动；
   B. 两态棋盘同一矩形（用户拍板：位置居中 + 大小占满宽度）——dock 改覆盖层，
      两态 .board-scroll padding 同值 → 非沉浸/沉浸棋盘矩形一致（Δ=0 恢复）。
   运行：NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
         C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/selftest-v128.js
   结果 JSON 输出到同目录 selftest-v128-result.json
 */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const results = [];
const pageErrors = [];
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

// CDP 合成 touch 拖动，返回拖动后页面滚动是否发生
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

  // ═══ A. 大厅一屏：4+ 视口无溢出、4 卡可见、按钮可见、互不重叠 ═══
  const HOME_VIEWPORTS = [
    { w: 412, h: 915, tag: '412×915' },
    { w: 360, h: 640, tag: '360×640' },
    { w: 412, h: 568, tag: '412×568(极矮)' },
    { w: 844, h: 390, tag: '844×390(横屏)' },
    { w: 812, h: 375, tag: '812×375(横屏)' },
  ];
  for (const vp of HOME_VIEWPORTS) {
    const page = await newPage(browser, vp.w, vp.h);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await measureHome(page);
    const tag = vp.tag;
    check(near(m.scrollH, m.clientH, 2), `A[${tag}] #view-home 无内部溢出 scrollH==clientH`,
      `scrollH=${m.scrollH} clientH=${m.clientH}`);
    check(m.cards.length === 4, `A[${tag}] 4 张模式卡片存在`, 'count=' + m.cards.length);
    const allIn = m.cards.every((c) => c.top >= -1 && c.bottom <= m.vh + 1 && c.left >= -1 && c.right <= m.vw + 1);
    check(allIn, `A[${tag}] 4 卡片全部在视口内`, JSON.stringify(m.cards.map((c) => [Math.round(c.top), Math.round(c.bottom)])));
    let overlap = false;
    for (let i = 0; i < m.cards.length; i++) {
      for (let j = i + 1; j < m.cards.length; j++) {
        const a = m.cards[i], b = m.cards[j];
        if (a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom) overlap = true;
      }
    }
    check(!overlap, `A[${tag}] 卡片两两不重叠`);
    const btnsVisible = m.cards.every((c) =>
      c.btns.length > 0 && c.btns.every((b) =>
        b.top >= c.top - 1 && b.bottom <= c.bottom + 1 && b.top >= 0 && b.bottom <= m.vh + 1));
    check(btnsVisible, `A[${tag}] 每卡按钮可见（在卡内且在视口内）`,
      JSON.stringify(m.cards.map((c) => c.btns.length)));
    check(m.doc.scrollW <= m.doc.clientW, `A[${tag}] 文档无横向溢出`, m.doc.scrollW + '≤' + m.doc.clientW);
    check(m.lockBound, `A[${tag}] lockHomeScroll 已绑定（dataset.lockHome=1）`);
    if (tag === '412×915') {
      await drag(page, 206, 400, 206, 520);
      const m2 = await measureHome(page);
      check(m2.scrollY === 0, 'A[412×915] 大厅 touch 拖动 120px 后 scrollY 恒 0', 'scrollY=' + m2.scrollY);
    }
    await page.close();
  }

  // ═══ B. 两态棋盘同一矩形（412×915）：dock 态 vs 沉浸态 ═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const docked = await measureGame(page);
    check(docked.dock && docked.dock.overlay, 'B1 非沉浸 dock 态：#ai-setup 为覆盖层(dock-overlay)',
      docked.dock ? 'h=' + Math.round(docked.dock.h) : 'none');
    check(docked.dockH > 0, 'B2 非沉浸 dock 态：--v128-dock-h 已写入实测高', docked.dockH + 'px');
    check(docked.board && docked.board.w === 412, 'B3 非沉浸 dock 态：棋盘占满宽度(412)', JSON.stringify(docked.board));
    check(docked.board && Math.abs((docked.board.x + docked.board.w / 2) - 206) < 2,
      'B4 非沉浸 dock 态：棋盘水平居中 cx=206',
      docked.board ? 'x=' + docked.board.x.toFixed(1) : 'no-board');

    await startGame(page);
    const imm = await measureGame(page);
    check(imm.immersive, 'B5 开局后进入沉浸态');
    check(imm.dockH > 0, 'B6 沉浸态：--v128-dock-h 保留（两态同值）', imm.dockH + 'px');
    check(imm.padB > 64, 'B7 沉浸态：padding-bottom 含 dock 预留(>64)', 'padB=' + imm.padB.toFixed(1));
    const same = docked.board && imm.board &&
      near(docked.board.x, imm.board.x, 1) && near(docked.board.y, imm.board.y, 1) &&
      near(docked.board.w, imm.board.w, 1) && near(docked.board.h, imm.board.h, 1);
    check(!!same, 'B8 两态棋盘矩形完全相同（Δ=0：x/y/w/h 全等）',
      'dock=' + JSON.stringify(docked.board) + ' imm=' + JSON.stringify(imm.board));
    check(imm.board && imm.board.w === 412, 'B9 沉浸态：棋盘占满宽度(412)', JSON.stringify(imm.board));
    check(imm.centerH, 'B10 沉浸态：棋盘水平居中', 'left=' + imm.gaps.left.toFixed(1) + ' right=' + imm.gaps.right.toFixed(1));
    const topGap = imm.board.y - imm.padT;
    const botGap = (imm.vh - imm.padB) - (imm.board.y + imm.board.h);
    check(Math.abs(topGap - botGap) <= 2, 'B11 沉浸态：棋盘垂直居中于内容区（margin:auto 语义）',
      'topGap=' + topGap.toFixed(1) + ' botGap=' + botGap.toFixed(1) + ' Δ=' + Math.abs(topGap - botGap).toFixed(1));
    // 沉浸态内容区 = 视口 − 顶72 − 底(64+dockH)；棋盘在内容区内 margin:auto 居中
    const availH = imm.vh - imm.padT - imm.padB;
    check(imm.board.h <= availH + 1, 'B12 沉浸态棋盘 ≤ 可用内容区（永不溢出）', imm.board.h.toFixed(1) + '≤' + availH.toFixed(1));
    await page.close();
  }

  // ═══ C. dock 覆盖不遮棋盘（412×915 与 360×640）═══
  for (const vp of [{ w: 412, h: 915, tag: '412×915' }, { w: 360, h: 640, tag: '360×640' }]) {
    const page = await newPage(browser, vp.w, vp.h);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const m = await measureGame(page);
    const ok = m.dock && m.board && (m.board.y + m.board.h) <= m.dock.top + 1;
    check(!!ok, `C[${vp.tag}] dock 顶缘 ≥ 棋盘底缘（不遮棋盘）`,
      'boardBottom=' + (m.board ? Math.round(m.board.y + m.board.h) : '-') +
      ' dockTop=' + (m.dock ? Math.round(m.dock.top) : '-'));
    check(m.dock && m.dock.top >= 0 && m.dock.bottom <= m.vh + 1, `C[${vp.tag}] dock 覆盖层在视口内`,
      m.dock ? 'top=' + Math.round(m.dock.top) + ' bottom=' + Math.round(m.dock.bottom) : 'no-dock');
    await page.close();
  }

  // ═══ D. 零滚动零拖动（两态，412×915）═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const d0 = await measureGame(page);
    const cx = d0.board.x + d0.board.w / 2, cy = d0.board.y + d0.board.h / 2;
    await drag(page, cx, cy, cx, cy + 120);
    const d1 = await measureGame(page);
    check(d1.scrollY === 0 && d1.scrollTop === 0, 'D1 非沉浸 dock 态：棋盘 touch 拖动 120px 位移 0',
      'scrollY=' + d1.scrollY + ' boardScrollTop=' + d1.scrollTop);
    check(d1.board && near(d1.board.x, d0.board.x, 1) && near(d1.board.y, d0.board.y, 1),
      'D2 非沉浸 dock 态：拖动后棋盘 rect 不变', JSON.stringify(d1.board));

    await startGame(page);
    const i0 = await measureGame(page);
    const ix = i0.board.x + i0.board.w / 2, iy = i0.board.y + i0.board.h / 2;
    await drag(page, ix, iy, ix, iy + 120);
    const i1 = await measureGame(page);
    check(i1.scrollY === 0 && i1.scrollTop === 0, 'D3 沉浸态：棋盘 touch 拖动 120px 位移 0',
      'scrollY=' + i1.scrollY + ' boardScrollTop=' + i1.scrollTop);
    check(i1.board && near(i1.board.x, i0.board.x, 1) && near(i1.board.y, i0.board.y, 1),
      'D4 沉浸态：拖动后棋盘矩形不变', JSON.stringify(i1.board));
    await page.close();
  }

  // ═══ E. 回归：进对局 → 开始对局 → 落子 → AI 回手（412×915 全链路）═══
  {
    const page = await newPage(browser, 412, 915);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const st0 = await page.textContent('#game-status');
    check(st0.indexOf('等待开局') >= 0, 'E1 进对局未开局：状态=等待开局', st0);
    await startGame(page);
    const st1 = await page.textContent('#game-status');
    check(st1.indexOf('轮到你') >= 0, 'E2 开局后玩家先手：状态=轮到你', st1);
    const m = await measureGame(page);
    const cx = m.board.x + 206, cy = m.board.y + 206;
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(80);
    const st2 = await page.textContent('#game-status');
    check(st2.indexOf('AI 思考') >= 0 || st2.indexOf('思考') >= 0, 'E3 落子被接受：状态进入 AI 思考', st2);
    const px = await page.evaluate(() => {
      const canvas = document.getElementById('board');
      const d = canvas.getContext('2d').getImageData(206, 211, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    });
    const lum = (px.r + px.g + px.b) / 3;
    check(lum < 100, 'E4 落子像素验证：天元格出现黑子（亮度=' + lum.toFixed(0) + '）', JSON.stringify(px));
    // 等待 AI 回手：状态回到「轮到你」（moves ≥ 2 的 DOM 信号）
    const replied = await page.waitForFunction(() => {
      const s = document.getElementById('game-status').textContent;
      return s.indexOf('思考') < 0 && (s.indexOf('轮到你') >= 0 || s.indexOf('获胜') >= 0 || s.indexOf('平局') >= 0);
    }, null, { timeout: 12000 }).then(() => true).catch(() => false);
    check(replied, 'E5 AI 回手成功（状态离开「AI 思考」回到玩家回合/终局）', await page.textContent('#game-status'));
    await page.close();
  }

  // ═══ F. 360×640 全链路无重叠 ═══
  {
    const page = await newPage(browser, 360, 640);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const d = await measureGame(page);
    check(d.dock && d.board && (d.board.y + d.board.h) <= d.dock.top + 1, 'F1 360×640 dock 态：dock 不遮棋盘',
      'boardBottom=' + Math.round(d.board.y + d.board.h) + ' dockTop=' + Math.round(d.dock.top));
    await startGame(page);
    const i = await measureGame(page);
    const same = d.board && i.board && near(d.board.x, i.board.x, 1) && near(d.board.y, i.board.y, 1) &&
      near(d.board.w, i.board.w, 1) && near(d.board.h, i.board.h, 1);
    check(!!same, 'F2 360×640 两态棋盘矩形一致', JSON.stringify(i.board));
    check(i.board && i.board.w <= i.vw && (i.board.y + i.board.h) <= i.vh, 'F3 360×640 沉浸棋盘在视口内');
    const st = await page.textContent('#game-status');
    check(st.indexOf('轮到你') >= 0, 'F4 360×640 开局后状态正常', st);
    await page.close();
  }

  // ═══ H. 全程无页面错误 ═══
  check(pageErrors.length === 0, 'H 全程无 pageerror / console.error', pageErrors.length ? pageErrors.join(' | ').slice(0, 400) : '');

  await browser.close();
  const out = { generatedAt: new Date().toISOString(), total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  fs.writeFileSync(path.join(__dirname, 'selftest-v128-result.json'), JSON.stringify(out, null, 2));
  console.log('\n==== selftest-v128 汇总 ====');
  console.log('PASS ' + out.passed + ' / ' + out.total + (out.failed ? '  FAIL ' + out.failed : ''));
  process.exit(out.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
