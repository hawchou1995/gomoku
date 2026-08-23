/* v1.2.7 取证探针：大厅可下拉？棋盘居中/宽度间隙？ */
const { chromium } = require('playwright-core');

const BASE = 'http://localhost:8391/index.html';
const results = [];

async function measure(page, label) {
  const r = await page.evaluate(() => {
    const out = { label: '', vw: innerWidth, vh: innerHeight };
    // ── 大厅滚动性 ──
    const html = document.documentElement;
    const body = document.body;
    out.html = { scrollH: html.scrollHeight, clientH: html.clientHeight, overflowY: getComputedStyle(html).overflowY, touchAction: getComputedStyle(body).touchAction, overscroll: getComputedStyle(body).overscrollBehaviorY };
    const home = document.querySelector('#view-home');
    if (home) { const hs = getComputedStyle(home); out.home = { scrollH: home.scrollHeight, clientH: home.clientHeight, overflowY: hs.overflowY, minH: hs.minHeight, h: home.getBoundingClientRect().height }; }
    // ── 棋盘 ──
    const wrap = document.querySelector('.board-wrap');
    if (wrap) {
      const rw = wrap.getBoundingClientRect();
      out.board = { x: Math.round(rw.x), y: Math.round(rw.y), w: Math.round(rw.width), h: Math.round(rw.height) };
      out.gaps = { left: Math.round(rw.x), right: Math.round(innerWidth - (rw.x + rw.width)), top: Math.round(rw.y), bottom: Math.round(innerHeight - (rw.y + rw.height)) };
      out.centered = { h: Math.abs((rw.x + rw.width / 2) - innerWidth / 2) < 2, v: Math.abs((rw.y + rw.height / 2) - innerHeight / 2) < 2 };
    }
    const gl = document.querySelector('.game-layout');
    if (gl) { const gr = gl.getBoundingClientRect(); out.gameLayout = { x: Math.round(gr.x), w: Math.round(gr.width), h: Math.round(gr.height) }; }
    return out;
  });
  results.push(r);
  console.log('=== ' + label + ' ===');
  console.log(JSON.stringify(r, null, 1));
}

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const scenarios = [
    { name: '竖屏412x915·大厅', vw: 412, vh: 915, view: 'home' },
    { name: '竖屏412x915·非沉浸(dock)', vw: 412, vh: 915, view: 'game', immersive: false },
    { name: '竖屏412x915·沉浸', vw: 412, vh: 915, view: 'game', immersive: true },
    { name: '横屏915x412·对局非沉浸', vw: 915, vh: 412, view: 'game', immersive: false },
    { name: '桌面1440x900·非沉浸', vw: 1440, vh: 900, view: 'game', immersive: false },
    { name: '桌面1440x900·沉浸', vw: 1440, vh: 900, view: 'game', immersive: true },
  ];
  for (const s of scenarios) {
    const page = await browser.newPage({ viewport: { width: s.vw, height: s.vh }, isMobile: s.vw <= 500, hasTouch: s.vw <= 500 });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    if (s.view === 'game') {
      // 进入对局（AI）
      await page.evaluate(() => { window.appTestEnterGame && window.appTestEnterGame(); });
      // 若未暴露测试钩子，则点卡片
      if (!(await page.evaluate(() => !!window.__v127InGame))) {
        await page.click('#btn-enter-ai').catch(() => {});
        await page.waitForTimeout(300);
      }
      if (s.immersive) {
        await page.evaluate(() => { document.body.classList.add('immersive'); window.dispatchEvent(new Event('resize')); });
        await page.waitForTimeout(200);
      }
    }
    await page.waitForTimeout(200);
    await measure(page, s.id);
    await page.close();
  }
  await browser.close();
  require('fs').writeFileSync(__dirname + '/probe-v127-result.json', JSON.stringify(results, null, 2));
  console.log('\nDONE');
})().catch(e => { console.error(e); process.exit(1); });
