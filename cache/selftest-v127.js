/* v1.2.7 工程自测（Task #81）
   三项 UI/交互修复：A 大厅禁下拉 / B 宽屏用满（去 480 上限）/ C 竖屏沉浸居中（放弃 Δ=0 门禁）
   运行：NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
         C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/selftest-v127.js
   结果 JSON 输出到同目录 selftest-v127-result.json
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

async function newPage(browser, w, h, touch) {
  const page = await browser.newPage({
    viewport: { width: w, height: h },
    isMobile: !!touch,
    hasTouch: !!touch,
  });
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') pageErrors.push('console:' + m.text()); });
  return page;
}

async function measure(page) {
  return page.evaluate(() => {
    const out = { vw: innerWidth, vh: innerHeight, scrollY: window.scrollY };
    const wrap = document.querySelector('.board-wrap');
    if (wrap) {
      const r = wrap.getBoundingClientRect();
      out.board = { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
      out.gaps = {
        left: Math.round(r.x),
        right: Math.round(innerWidth - (r.x + r.width)),
        top: Math.round(r.y),
        bottom: Math.round(innerHeight - (r.y + r.height)),
      };
      out.centerH = Math.abs((r.x + r.width / 2) - innerWidth / 2) < 2;
      out.centerV = Math.abs((r.y + r.height / 2) - innerHeight / 2) < 2;
    }
    const gl = document.querySelector('#view-game .game-layout');
    if (gl) {
      const gr = gl.getBoundingClientRect();
      out.gl = { x: Math.round(gr.x), w: Math.round(gr.width), maxW: getComputedStyle(gl).maxWidth };
    }
    const bs = document.querySelector('.board-scroll');
    if (bs) {
      const cs = getComputedStyle(bs);
      out.padT = parseFloat(cs.paddingTop) || 0;
      out.padB = parseFloat(cs.paddingBottom) || 0;
      out.bsScrollW = bs.scrollWidth;
      out.bsClientW = bs.clientWidth;
    }
    out.doc = { scrollW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth };
    const home = document.getElementById('view-home');
    if (home) {
      const hs = getComputedStyle(home);
      out.home = { touchAction: hs.touchAction, overscrollY: hs.overscrollBehaviorY, scrollTop: home.scrollTop };
    }
    return out;
  });
}

// 在目标元素上做 CDP 合成 touch 拖动，返回页面滚动是否发生
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
  await page.waitForTimeout(300);
}

async function startGame(page) {
  await page.evaluate(() => document.getElementById('btn-start-ai').click());
  await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 5000 });
  await page.waitForTimeout(350);
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });

  // ═══ A. 大厅禁下拉（412×915 移动端）═══
  {
    const page = await newPage(browser, 412, 915, true);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(300);
    const m = await measure(page);

    check(m.home && m.home.touchAction === 'none', 'A1 #view-home touch-action 为 none', m.home && m.home.touchAction);
    check(m.home && m.home.overscrollY === 'none', 'A2 #view-home overscroll-behavior-y 为 none', m.home && m.home.overscrollY);

    // A3: 合成 touchmove → #view-home 上 preventDefault（bubble 观察 defaultPrevented）
    const synth = await page.evaluate(() => {
      const home = document.getElementById('view-home');
      let observed = null;
      const obs = (e) => { observed = e.defaultPrevented; };
      document.addEventListener('touchmove', obs); // bubble：晚于 target 上 lockHomeScroll 的 handler
      let constructed = false;
      try {
        const t = new Touch({ identifier: 1, target: home, clientX: 100, clientY: 100 });
        const ev = new TouchEvent('touchmove', {
          bubbles: true, cancelable: true,
          touches: [t], targetTouches: [t], changedTouches: [t],
        });
        home.dispatchEvent(ev);
        constructed = true;
      } catch (e) { /* TouchEvent 不可用（异常环境） */ }
      document.removeEventListener('touchmove', obs);
      return { constructed, beforePrevented: observed, homeHasLock: home.dataset.lockHome === '1' };
    });
    check(synth.homeHasLock, 'A3 #view-home 已绑定 lockHomeScroll（dataset.lockHome=1）');
    check(synth.constructed && synth.beforePrevented === true, 'A4 #view-home touchmove 已被 preventDefault（无冒泡滚动）',
      'constructed=' + synth.constructed + ' defaultPrevented=' + synth.beforePrevented);

    // A5: CDP 真实 touch 拖动 120px → 页面/大厅 scrollTop 恒 0
    await drag(page, 206, 400, 206, 520);
    const after = await measure(page);
    check(after.scrollY === 0 && after.home.scrollTop === 0, 'A5 大厅 touch 拖动 120px 后 scrollY/scrollTop 恒 0',
      'scrollY=' + after.scrollY + ' home.scrollTop=' + after.home.scrollTop);
    check(after.doc.scrollW <= after.doc.clientW, 'A6 大厅无横向溢出', after.doc.scrollW + '≤' + after.doc.clientW);
    await page.close();
  }

  // ═══ C. 竖屏 412×915 沉浸（开局后）═══
  {
    const page = await newPage(browser, 412, 915, true);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    await startGame(page);
    const m = await measure(page);

    check(m.board && m.board.w === 412, 'C1 竖屏沉浸 棋盘宽 = 412', JSON.stringify(m.board));
    const padT = m.padT, padB = m.padB;
    const topBarGap = m.board.y - padT;
    const bottomBarGap = (m.vh - padB) - (m.board.y + m.board.h);
    const barDiff = Math.abs(topBarGap - bottomBarGap);
    check(barDiff <= 2, 'C2 竖屏沉浸 棋盘于顶条(72)/底条(64)之间垂直居中（Δ≤2）',
      'topBarGap=' + topBarGap.toFixed(1) + ' bottomBarGap=' + bottomBarGap.toFixed(1) + ' Δ=' + barDiff.toFixed(1) +
      ' | 视口 top=' + m.gaps.top + ' bottom=' + m.gaps.bottom);
    check(m.gaps.left === 0 && m.gaps.right === 0, 'C3 竖屏沉浸 棋盘水平铺满（左右 gap=0）',
      'left=' + m.gaps.left + ' right=' + m.gaps.right);
    check(m.padB === 64 && m.padT === 72, 'C4 沉浸 padding = 72/64（safe-area=0 不重复计入、dock 净空已移除）',
      'padT=' + m.padT + ' padB=' + m.padB);
    check(m.doc.scrollW <= m.doc.clientW && m.scrollY === 0, 'C5 竖屏沉浸 零滚动（无横向溢出）',
      m.doc.scrollW + '≤' + m.doc.clientW + ' scrollY=' + m.scrollY);
    // C6: 棋盘上 touch 拖动 → 零位移（scrollTop 恒 0）
    const cx = m.board.x + m.board.w / 2, cy = m.board.y + m.board.h / 2;
    await drag(page, cx, cy, cx, cy + 100);
    const m2 = await measure(page);
    check(m2.scrollY === 0, 'C6 竖屏沉浸 棋盘 touch 拖动 100px 后页面零滚动', 'scrollY=' + m2.scrollY);
    await page.close();
  }

  // ═══ B. 桌面 1440×900 非沉浸（宽屏用满）═══
  {
    const page = await newPage(browser, 1440, 900, false);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const m = await measure(page);
    check(m.board && m.board.w === 764, 'B1 桌面非沉浸 棋盘宽 = 764（480→764）', JSON.stringify(m.board));
    check(m.centerH, 'B2 桌面非沉浸 棋盘水平居中', 'left=' + m.gaps.left + ' right=' + m.gaps.right);
    check(m.gl && m.gl.maxW === 'none', 'B3 .game-layout max-width 已解除（none）', m.gl && m.gl.maxW);
    check(m.gl && m.gl.w === 1440, 'B4 .game-layout 铺满视口宽', m.gl && ('w=' + m.gl.w));
    check(m.doc.scrollW <= m.doc.clientW, 'B5 桌面非沉浸 无横向溢出', m.doc.scrollW + '≤' + m.doc.clientW);
    await page.close();
  }

  // ═══ D. 桌面 1440×900 沉浸（宽屏用满 + 顶条/底条间居中）═══
  {
    const page = await newPage(browser, 1440, 900, false);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    await startGame(page);
    const m = await measure(page);
    check(m.board && m.board.w === 764, 'D1 桌面沉浸 棋盘宽 = 764', JSON.stringify(m.board));
    check(m.centerH, 'D2 桌面沉浸 棋盘水平居中', 'left=' + m.gaps.left + ' right=' + m.gaps.right);
    const topBarGap = m.board.y - m.padT;
    const bottomBarGap = (m.vh - m.padB) - (m.board.y + m.board.h);
    check(Math.abs(topBarGap - bottomBarGap) <= 2, 'D3 桌面沉浸 棋盘于 72..836 之间垂直居中（Δ≤2）',
      'topBarGap=' + topBarGap.toFixed(1) + ' bottomBarGap=' + bottomBarGap.toFixed(1));
    check(m.doc.scrollW <= m.doc.clientW && m.scrollY === 0, 'D4 桌面沉浸 零滚动', m.doc.scrollW + '≤' + m.doc.clientW);
    await page.close();
  }

  // ═══ E. 横屏 915×412 非沉浸（min 语义，高度受限）═══
  {
    const page = await newPage(browser, 915, 412, true);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const m = await measure(page);
    check(m.board && m.board.w === 304, 'E1 横屏非沉浸 棋盘宽 = 304（min(宽,高) 高度受限属正常）', JSON.stringify(m.board));
    check(m.centerH, 'E2 横屏非沉浸 水平居中', 'left=' + m.gaps.left + ' right=' + m.gaps.right);
    check(m.doc.scrollW <= m.doc.clientW && m.scrollY === 0, 'E3 横屏非沉浸 零滚动', m.doc.scrollW + '≤' + m.doc.clientW);
    await page.close();
  }

  // ═══ G. 回归：竖屏进对局 → 开局 → 落子可用 ═══
  {
    const page = await newPage(browser, 412, 915, true);
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await enterGame(page);
    const statusBefore = await page.textContent('#game-status');
    check(statusBefore.indexOf('等待开局') >= 0 || statusBefore === '等待开局…', 'G1 进对局未开局：状态=等待开局…', statusBefore);
    await startGame(page);
    const st = await page.textContent('#game-status');
    check(st.indexOf('轮到你') >= 0, 'G2 开局后玩家先手：状态=轮到你', st);
    const m = await measure(page);
    check(m.board && m.board.w === 412, 'G3 开局后棋盘 412 宽（沉浸）', JSON.stringify(m.board));
    // 真实指针点击棋盘中央（H8 天元）→ 落子
    const cx = m.board.x + 206, cy = m.board.y + 206; // board 内 (206,206) = 天元格
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(80);
    const stAfter = await page.textContent('#game-status');
    check(stAfter.indexOf('AI 思考') >= 0 || stAfter.indexOf('思考') >= 0, 'G4 落子被接受：状态进入 AI 思考', stAfter);
    // 像素验证：棋盘天元格中心出现黑子（(206,206) 相对 canvas 中心；采样 (206,211) 避开星位）
    const px = await page.evaluate(() => {
      const canvas = document.getElementById('board');
      const d = canvas.getContext('2d').getImageData(206, 211, 1, 1).data;
      return { r: d[0], g: d[1], b: d[2] };
    });
    const lum = (px.r + px.g + px.b) / 3;
    check(lum < 100, 'G5 落子像素验证：天元格出现黑子（亮度=' + lum.toFixed(0) + '）', JSON.stringify(px));
    await page.waitForTimeout(600);
    const m3 = await measure(page);
    check(m3.scrollY === 0 && m3.doc.scrollW <= m3.doc.clientW, 'G6 对局中零滚动', 'scrollY=' + m3.scrollY);
    await page.close();
  }

  // ═══ 汇总 ═══
  check(pageErrors.length === 0, 'H 全程无 pageerror / console.error', pageErrors.length ? pageErrors.join(' | ').slice(0, 300) : '');

  await browser.close();
  const out = { generatedAt: new Date().toISOString(), total: results.length, passed: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  fs.writeFileSync(path.join(__dirname, 'selftest-v127-result.json'), JSON.stringify(out, null, 2));
  console.log('\n==== selftest-v127 汇总 ====');
  console.log('PASS ' + out.passed + ' / ' + out.total + (out.failed ? '  FAIL ' + out.failed : ''));
  process.exit(out.failed ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
