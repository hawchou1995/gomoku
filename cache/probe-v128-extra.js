/* v1.2.8 补充探针：320×568 极窄 + LAN 模式 dock 变量清理 + 抽屉盖过 dock */
const { chromium } = require('playwright-core');
const BASE = 'http://localhost:8391/index.html';
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: EDGE });
  const out = [];

  // 1) 320×568 home
  {
    const page = await browser.newPage({ viewport: { width: 320, height: 568 }, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const home = document.getElementById('view-home');
      const cards = Array.from(document.querySelectorAll('#view-home .mode-card')).map((c) => {
        const r = c.getBoundingClientRect();
        const btns = Array.from(c.querySelectorAll('.btn')).map((b) => {
          const br = b.getBoundingClientRect();
          return br.top >= r.top - 1 && br.bottom <= r.bottom + 1;
        });
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), btnsOk: btns.every(Boolean) };
      });
      return {
        scrollH: home.scrollHeight, clientH: home.clientHeight,
        cards, docW: document.documentElement.scrollWidth, docC: document.documentElement.clientWidth,
      };
    });
    out.push(['320×568 home scrollH==clientH', Math.abs(m.scrollH - m.clientH) <= 2, m.scrollH + '/' + m.clientH]);
    out.push(['320×568 4 cards in view + buttons visible', m.cards.length === 4 && m.cards.every((c) => c.top >= -1 && c.bottom <= 568 && c.btnsOk), JSON.stringify(m.cards)]);
    out.push(['320×568 no h overflow', m.docW <= m.docC, m.docW + '≤' + m.docC]);
    await page.close();
  }

  // 2) LAN 模式：dock 变量应清除（board 底 padding = 64）
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      // 直接触发建房（LAN）：点击创建房间 → 模态确认
      document.getElementById('btn-lan-create').click();
    });
    await page.waitForTimeout(400);
    // 模态里点「创建」
    await page.evaluate(() => { const b = document.getElementById('m-create-ok'); if (b) b.click(); });
    await page.waitForTimeout(400);
    const m = await page.evaluate(() => {
      const bs = document.querySelector('.board-scroll');
      const cs = getComputedStyle(bs);
      const dockH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--v128-dock-h')) || 0;
      const dock = document.getElementById('ai-setup');
      const overlay = dock.classList.contains('dock-overlay');
      return { dockH, padB: parseFloat(cs.paddingBottom), overlay, display: getComputedStyle(dock).display };
    });
    out.push(['LAN mode --v128-dock-h cleared', m.dockH === 0 && m.padB === 64 && !m.overlay && m.display === 'none',
      'dockH=' + m.dockH + ' padB=' + m.padB + ' overlay=' + m.overlay + ' display=' + m.display]);
    await page.close();
  }

  // 3) 抽屉盖过 dock：open drawer → side-panel.open 且 z 高于 dock
  {
    const page = await browser.newPage({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await page.click('#btn-enter-ai');
    await page.waitForTimeout(350);
    await page.click('#btn-floating-settings');
    await page.waitForTimeout(300);
    const m = await page.evaluate(() => {
      const sp = document.querySelector('.side-panel');
      const dock = document.getElementById('ai-setup');
      return {
        open: sp.classList.contains('open'),
        spZ: getComputedStyle(sp).zIndex,
        dockZ: getComputedStyle(dock).zIndex,
        dockOverlay: dock.classList.contains('dock-overlay'),
      };
    });
    out.push(['drawer open above dock', m.open && m.dockOverlay && parseInt(m.spZ, 10) > parseInt(m.dockZ, 10),
      'spZ=' + m.spZ + ' dockZ=' + m.dockZ]);
    await page.close();
  }

  await browser.close();
  let allOk = true;
  for (const [name, ok, detail] of out) {
    allOk = allOk && ok;
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  [' + detail + ']');
  }
  console.log('probe extra: ' + (allOk ? 'ALL PASS' : 'HAS FAIL'));
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(2); });
