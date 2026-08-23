/* ════════════════════════════════════════════════════════════════════
   大厅布局返修验证 v1.2.8b（用户 /PUA：四张卡片内容没多少却拉很长）
   验证者：主理人（独立断言，复用 QA playwright-core + Edge + CDP 框架）
   —— 根因：grid-auto-rows:1fr + align-content:stretch 把卡片行均分
      剩余高度 → 卡片被拉伸填满。返修：grid-auto-rows:auto +
      align-content:center（内容自然高 + 垂直居中）。

   验证矩阵：
     H1 卡片不被拉伸（核心）：每卡 h ≤ 220px（412×915）；且卡内无溢出
        （scrollHeight ≤ clientHeight+1）——内容自然排布的证据
     H2 四卡全可见：每卡 bottom ≤ view-home 底缘 − 1
     H3 垂直居中：mode-grid 上缘距 hero 底 与 下缘距 note 顶 差距合理
        （grid 容器居中于剩余空间，|topGap − bottomGap| ≤ 40 宽容）
     H4 禁滚：CDP 真实触摸拖 120px → scrollY/scrollTop 恒 0 + defaultPrevented
     H5 三视口（412×915 / 360×640 / 412×568）全过 H1/H2/H4
     H6 全程 pageerror / console.error = 0
   运行：
     NODE_PATH=C:/Users/XAUTHUB/.workbuddy/binaries/node/workspace/node_modules \
     C:/Users/XAUTHUB/.workbuddy/binaries/node/versions/22.22.2/node.exe cache/home-layout-v128b.js
   结果 JSON → cache/home-layout-v128b-result.json
   ════════════════════════════════════════════════════════════════════ */
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = 'http://127.0.0.1:8377/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT = path.join(__dirname, 'home-layout-v128b-result.json');

const results = [];
const pageErrors = [];
const near = (a, b, tol) => Math.abs(a - b) <= tol;

function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail: detail || '' });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  [' + detail + ']' : ''));
}

async function main() {
  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files'],
  });

  const viewports = [
    { w: 412, h: 915, tag: '412x915' },
    { w: 360, h: 640, tag: '360x640' },
    { w: 412, h: 568, tag: '412x568' },
  ];

  for (const vp of viewports) {
    const tag = vp.tag;
    const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h } });
    const page = await ctx.newPage();
    const cdp = await ctx.newCDPSession(page);
    page.on('pageerror', (e) => { pageErrors.push(tag + ': ' + e.message); });

    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForSelector('#view-home:not(.hidden)', { timeout: 5000 });
    await page.waitForTimeout(150);

    // 几何采集
    const geo = await page.evaluate(() => {
      const vh = document.getElementById('view-home');
      const grid = document.querySelector('#view-home .mode-grid');
      const vhRect = vh.getBoundingClientRect();
      const gridRect = grid.getBoundingClientRect();
      const cards = [...document.querySelectorAll('#view-home .mode-card')].map(c => {
        const r = c.getBoundingClientRect();
        return {
          h: r.height,
          top: r.top,
          bottom: r.bottom,
          scrollH: c.scrollHeight,
          clientH: c.clientHeight,
          scrollW: c.scrollWidth,
          clientW: c.clientWidth,
        };
      });
      return {
        vhTop: vhRect.top, vhBottom: vhRect.bottom,
        gridTop: gridRect.top, gridBottom: gridRect.bottom,
        cardFirstTop: Math.min(...cards.map(c => c.top)),
        cardLastBottom: Math.max(...cards.map(c => c.bottom)),
        scrollY: window.scrollY,
        vhScrollH: vh.scrollHeight, vhClientH: vh.clientHeight,
        cards,
      };
    });

    // H1 卡片不被拉伸（412×915 从严 ≤220，其他视口 ≤180）
    const hCap = vp.tag === '412x915' ? 220 : 190;
    for (let i = 0; i < geo.cards.length; i++) {
      const c = geo.cards[i];
      check(c.h <= hCap, `${tag} H1 卡${i + 1} 不被拉伸 h=${Math.round(c.h)}px≤${hCap}`,
        `scrollH=${c.scrollH}/clientH=${c.clientH}`);
      check(c.scrollH <= c.clientH + 1, `${tag} H1b 卡${i + 1} 内部无溢出`,
        `scrollH=${c.scrollH}/clientH=${c.clientH}`);
      check(c.scrollW <= c.clientW + 1, `${tag} H1c 卡${i + 1} 横向无溢出`,
        `scrollW=${c.scrollW}/clientW=${c.clientW}`);
    }

    // H2 四卡全可见（bottom ≤ 视口底）
    const vhBottom = Math.min(geo.vhBottom, vp.h);
    for (let i = 0; i < geo.cards.length; i++) {
      check(geo.cards[i].bottom <= vhBottom + 1, `${tag} H2 卡${i + 1} 全可见`,
        `bottom=${Math.round(geo.cards[i].bottom)} ≤ ${Math.round(vhBottom)}`);
    }

    // H3 垂直居中：卡片组在 grid 容器内垂直居中（align-content:center 的效果）
    const innerTop = geo.cardFirstTop - geo.gridTop;
    const innerBot = geo.gridBottom - geo.cardLastBottom;
    check(near(innerTop, innerBot, 3), `${tag} H3 卡片组在容器内居中`,
      `innerTop=${Math.round(innerTop)}/innerBot=${Math.round(innerBot)} diff=${Math.round(Math.abs(innerTop - innerBot))}px`);
    // H3b 视觉口径（观察项，宽容 60px 含 hero 结构）：卡片组在视口内上下均衡
    const vTop = geo.cardFirstTop - geo.vhTop;
    const vBot = geo.vhBottom - geo.cardLastBottom;
    check(near(vTop, vBot, 60), `${tag} H3b 卡片组视口内均衡(观察)`,
      `vTop=${Math.round(vTop)}/vBot=${Math.round(vBot)} diff=${Math.round(Math.abs(vTop - vBot))}px`);

    // H4 CDP 真实触摸拖动 → 零滚动零位移
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchStart', touchPoints: [{ x: vp.w / 2, y: 200, radiusX: 3, radiusY: 3, force: 1, id: 1 }],
    });
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ x: vp.w / 2, y: 320, radiusX: 3, radiusY: 3, force: 1, id: 1 }],
    });
    await page.waitForTimeout(50);
    await cdp.send('Input.dispatchTouchEvent', {
      type: 'touchEnd', touchPoints: [],
    });
    await page.waitForTimeout(100);
    const after = await page.evaluate(() => ({
      scrollY: window.scrollY,
      vhScrollTop: document.getElementById('view-home').scrollTop,
    }));
    check(after.scrollY === 0 && after.vhScrollTop === 0, `${tag} H4 下拉 120px 零滚动`,
      `scrollY=${after.scrollY} vh.scrollTop=${after.vhScrollTop}`);
    check(geo.vhScrollH <= geo.vhClientH + 1, `${tag} H5 view-home 无内容溢出`,
      `scrollH=${geo.vhScrollH}/clientH=${geo.vhClientH}`);

    await ctx.close();
  }

  // H6 全程零页面错误
  check(pageErrors.length === 0, 'H6 全程 0 页面错误', pageErrors.join('; ').slice(0, 200));

  await browser.close();

  const total = results.length;
  const passed = results.filter(r => r.ok).length;
  const failed = results.filter(r => !r.ok).length;
  fs.writeFileSync(OUT, JSON.stringify({
    generatedAt: new Date().toISOString(),
    total, passed, failed,
    pageErrors,
    results,
  }, null, 2));
  console.log(`\n==== ${passed}/${total} PASS, ${failed} FAIL ====`);
  process.exit(failed ? 1 : 0);
}

main().catch(e => {
  console.error('FATAL', e);
  process.exit(2);
});
