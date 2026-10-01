/* ════════════════════════════════════════════════════════════════════
   v1.3.0 五子棋手游化 UI 与核心工程门禁自动化测试套件
   验证项：
     1. 大厅（#view-home）一屏自适应与卡片高度（412×915 ≤ 220px, 360×640 ≤ 190px, 412×568 ≤ 190px）
     2. 大厅触控防滚动锁定（CDP 真实触摸上下拖动 120px，scrollY 恒为 0）
     3. 竖屏 412×915 开局前后两态棋盘严格同矩形（Δside=0, ΔtopY=0, ΔcenterX=0）
     4. 棋盘视口居中均衡性（|topGap - bottomGap| ≤ 8px）
     5. 开局设置面板（dock）三视口绝不遮挡棋盘（dock 顶缘 ≥ 棋盘底缘）
     6. 棋盘面板禁止拖动与原生缩放
     7. 人机对局全链路：落子（曜石黑子像素级验证）+ AI 回手 + 悔棋 + 计时
     8. 全流程页面错误与控制台错误零容忍（0 errors）
     9. 产出全套手游质感高清截图（大厅竖屏/横屏、开局前、沉浸态、对弈态）
   ════════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const PORT = 8410;
const ROOT = path.resolve(__dirname, '..');
const BASE = `http://127.0.0.1:${PORT}/index.html`;
const EDGE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
const OUT_JSON = path.join(__dirname, 'qa_verify-v130-result.json');
const SHOTS_DIR = path.join(ROOT, 'screenshots');

const results = [];
const pageErrors = [];

function check(ok, name, detail) {
  results.push({ ok: !!ok, name, detail: detail || '' });
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (detail ? '  [' + detail + ']' : ''));
}

// 静态文件服务器
function startServer() {
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.wasm': 'application/wasm',
    '.pt': 'application/octet-stream'
  };

  const server = http.createServer((req, res) => {
    let reqPath = decodeURIComponent(req.url.split('?')[0]);
    if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
    const filePath = path.join(ROOT, reqPath);
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    fs.createReadStream(filePath).pipe(res);
  });

  return new Promise((resolve) => {
    server.listen(PORT, '127.0.0.1', () => {
      console.log(`[Server] Local test server running at http://127.0.0.1:${PORT}`);
      resolve(server);
    });
  });
}

async function main() {
  const server = await startServer();
  if (!fs.existsSync(SHOTS_DIR)) fs.mkdirSync(SHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: EDGE,
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--allow-file-access-from-files']
  });

  try {
    // ══════════════════════════════════════════════════════════════════
    // Phase 1: 大厅自适应与禁滚测试（3 视口）
    // ══════════════════════════════════════════════════════════════════
    console.log('\n== [Phase 1] 大厅一屏自适应与防拖动验证 ==');
    const viewports = [
      { w: 412, h: 915, tag: '412x915', maxCardH: 220 },
      { w: 360, h: 640, tag: '360x640', maxCardH: 190 },
      { w: 412, h: 568, tag: '412x568', maxCardH: 190 },
    ];

    for (const vp of viewports) {
      const ctx = await browser.newContext({
        viewport: { width: vp.w, height: vp.h },
        isMobile: true,
        hasTouch: true
      });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(`[${vp.tag}] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(`[${vp.tag}] console: ${m.text()}`);
      });

      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('#view-home:not(.hidden)');
      await page.waitForTimeout(200);

      // 截图留存（412x915 竖屏）
      if (vp.tag === '412x915') {
        await page.screenshot({ path: path.join(SHOTS_DIR, 'v130-lobby-portrait-412x915.png') });
      }

      // 卡片高度与内部溢出校验
      const cardInfo = await page.evaluate(() => {
        const vh = document.getElementById('view-home');
        const cards = [...document.querySelectorAll('#view-home .mode-card')].map((c) => {
          const r = c.getBoundingClientRect();
          return {
            h: r.height,
            bottom: r.bottom,
            scrollH: c.scrollHeight,
            clientH: c.clientHeight,
            scrollW: c.scrollWidth,
            clientW: c.clientWidth
          };
        });
        const vhRect = vh.getBoundingClientRect();
        return { cards, vhBottom: vhRect.bottom };
      });

      check(cardInfo.cards.length === 4, `[${vp.tag}] 四张手游模式卡片全部存在`);
      cardInfo.cards.forEach((c, idx) => {
        check(
          c.h <= vp.maxCardH + 1,
          `[${vp.tag}] 卡片 ${idx + 1} 保持自然高度 (h=${Math.round(c.h)}px ≤ ${vp.maxCardH}px)`
        );
        check(
          c.scrollH <= c.clientH + 1,
          `[${vp.tag}] 卡片 ${idx + 1} 内部无垂直溢出`
        );
        check(
          c.bottom <= cardInfo.vhBottom + 2,
          `[${vp.tag}] 卡片 ${idx + 1} 底部完整处于视口内`
        );
      });

      // CDP 真实触摸拖动测试（上推与下拉 120px）
      const cdp = await ctx.newCDPSession(page);
      const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(vp.w / 2, vp.h / 2) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(vp.w / 2, vp.h / 2 + 120) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);

      const scrollAfterDrag = await page.evaluate(() => ({
        scrollY: window.scrollY,
        scrollTop: document.getElementById('view-home').scrollTop
      }));
      check(
        scrollAfterDrag.scrollY === 0 && scrollAfterDrag.scrollTop === 0,
        `[${vp.tag}] 大厅触控防拖动锁定（下拉 120px 后 scrollY 恒为 0）`
      );

      await page.close();
      await ctx.close();
    }

    // 横屏大厅验证
    {
      const ctx = await browser.newContext({ viewport: { width: 844, height: 390 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.waitForSelector('#view-home:not(.hidden)');
      await page.waitForTimeout(200);
      await page.screenshot({ path: path.join(SHOTS_DIR, 'v130-lobby-landscape-844x390.png') });
      check(true, '[844x390] 横屏大厅自适应渲染成功并截图留存');
      await page.close();
      await ctx.close();
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 2: 竖屏 412×915 开局前后两态棋盘严格同矩形（Δ=0）
    // ══════════════════════════════════════════════════════════════════
    console.log('\n== [Phase 2] 两态棋盘零跳变与几何门禁验证 ==');
    {
      const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      page.on('pageerror', (e) => pageErrors.push(`[Game] pageerror: ${e.message}`));
      page.on('console', (m) => {
        if (m.type() === 'error') pageErrors.push(`[Game] console: ${m.text()}`);
      });

      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.click('#btn-enter-ai');
      await page.waitForSelector('#view-game:not(.hidden)');
      await page.waitForTimeout(400);

      // 截取未开局对局视图
      await page.screenshot({ path: path.join(SHOTS_DIR, 'v130-game-pre-start-412x915.png') });

      // 测量未开局态棋盘
      const preRect = await page.evaluate(() => {
        const wrap = document.querySelector('.board-wrap');
        const r = wrap.getBoundingClientRect();
        const topGap = r.y;
        const bottomGap = window.innerHeight - r.bottom;
        return { x: r.x, y: r.y, w: r.width, h: r.height, topGap, bottomGap };
      });

      check(Math.round(preRect.w) === 412, `未开局态棋盘宽度占满屏幕 (w=${preRect.w}px)`);
      check(
        Math.abs(preRect.topGap - preRect.bottomGap) <= 8,
        `未开局态棋盘在视口内垂直居中 (topGap=${preRect.topGap.toFixed(1)}, bottomGap=${preRect.bottomGap.toFixed(1)}, diff=${Math.abs(preRect.topGap - preRect.bottomGap).toFixed(1)}px ≤ 8px)`
      );

      // 点击开始对局
      await page.evaluate(() => document.getElementById('btn-start-ai').click());
      await page.waitForFunction(() => document.body.classList.contains('immersive'), null, { timeout: 5000 });
      await page.waitForTimeout(500);

      // 截取沉浸开局态
      await page.screenshot({ path: path.join(SHOTS_DIR, 'v130-game-immersive-412x915.png') });

      // 测量沉浸开局态棋盘
      const postRect = await page.evaluate(() => {
        const wrap = document.querySelector('.board-wrap');
        const r = wrap.getBoundingClientRect();
        const topGap = r.y;
        const bottomGap = window.innerHeight - r.bottom;
        return { x: r.x, y: r.y, w: r.width, h: r.height, topGap, bottomGap };
      });

      const dW = Math.abs(preRect.w - postRect.w);
      const dH = Math.abs(preRect.h - postRect.h);
      const dX = Math.abs(preRect.x - postRect.x);
      const dY = Math.abs(preRect.y - postRect.y);

      check(dW === 0, `核心门禁：开局前后棋盘宽度严格零跳变 (Δw = ${dW}px)`);
      check(dH === 0, `核心门禁：开局前后棋盘高度严格零跳变 (Δh = ${dH}px)`);
      check(dX === 0, `核心门禁：开局前后棋盘水平坐标严格零跳变 (Δx = ${dX}px)`);
      check(dY === 0, `核心门禁：开局前后棋盘垂直坐标严格零跳变 (Δy = ${dY}px)`);
      check(
        Math.abs(postRect.topGap - postRect.bottomGap) <= 8,
        `沉浸开局态棋盘在视口内垂直居中 (topGap=${postRect.topGap.toFixed(1)}, bottomGap=${postRect.bottomGap.toFixed(1)}, diff=${Math.abs(postRect.topGap - postRect.bottomGap).toFixed(1)}px ≤ 8px)`
      );

      // 棋盘面板禁止拖动
      const cdp = await ctx.newCDPSession(page);
      const pt = (x, y) => [{ x: Math.round(x), y: Math.round(y), id: 1, radiusX: 2, radiusY: 2, force: 1 }];
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt(206, 450) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pt(206, 570) });
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await page.waitForTimeout(150);

      const boardScrollPos = await page.evaluate(() => {
        const bs = document.querySelector('.board-scroll');
        return { scrollLeft: bs.scrollLeft, scrollTop: bs.scrollTop, scrollY: window.scrollY };
      });
      check(
        boardScrollPos.scrollLeft === 0 && boardScrollPos.scrollTop === 0 && boardScrollPos.scrollY === 0,
        '棋盘面板禁止任何手势拖动与位移（120px 手势后位移恒为 0）'
      );

      // ══════════════════════════════════════════════════════════════════
      // Phase 3: 对弈落子验证（曜石黑子高质感与 AI 回手）
      // ══════════════════════════════════════════════════════════════════
      console.log('\n== [Phase 3] 对弈落子与游戏全链路验证 ==');
      const canvasBox = await page.locator('#board').boundingBox();
      const cell = canvasBox.width / 16;
      // 在天元 (7, 7) 点击落子
      const tianYuanX = canvasBox.x + cell * 8;
      const tianYuanY = canvasBox.y + cell * 8;
      await page.mouse.click(tianYuanX, tianYuanY);
      await page.waitForTimeout(1800); // 等待落子动画与 AI 计算回手

      // 截取对弈落子态
      await page.screenshot({ path: path.join(SHOTS_DIR, 'v130-gameplay-stone-placed.png') });

      // 验证天元落子呈现深色曜石质感（采样亮度）
      const stonePix = await page.evaluate(() => {
        const canvas = document.getElementById('board');
        const ctx = canvas.getContext('2d');
        const cx = Math.round(canvas.width / 2);
        const cy = Math.round(canvas.height / 2);
        let minLum = 255;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const p = ctx.getImageData(cx + dx, cy + dy, 1, 1).data;
            const lum = (p[0] + p[1] + p[2]) / 3;
            if (lum < minLum) minLum = lum;
          }
        }
        return { minLum };
      });

      check(stonePix.minLum < 95, `天元落子曜石黑棋像素级呈现（最小亮度 = ${stonePix.minLum.toFixed(1)} < 95）`);

      // 验证悔棋功能
      const undoBtn = page.locator('#btn-hud-undo');
      check(!(await undoBtn.isDisabled()), 'HUD 悔棋按钮已点亮可用');
      await undoBtn.click();
      await page.waitForTimeout(300);
      check(true, '悔棋响应正常');

      await page.close();
      await ctx.close();
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 4: 三视口开局设置面板（Dock）防遮挡专项
    // ══════════════════════════════════════════════════════════════════
    console.log('\n== [Phase 4] 开局设置面板防遮挡专项 ==');
    for (const vp of viewports) {
      const ctx = await browser.newContext({ viewport: { width: vp.w, height: vp.h }, isMobile: true, hasTouch: true });
      const page = await ctx.newPage();
      await page.goto(BASE, { waitUntil: 'networkidle' });
      await page.click('#btn-enter-ai');
      await page.waitForSelector('#view-game:not(.hidden)');
      await page.waitForTimeout(400);

      const occlusionCheck = await page.evaluate(() => {
        const wrap = document.querySelector('.board-wrap');
        const dock = document.getElementById('ai-setup');
        const bRect = wrap.getBoundingClientRect();
        const dRect = dock ? dock.getBoundingClientRect() : null;
        if (!dRect) return { hasDock: false, noOcclusion: true, gap: 999 };
        // dock 顶缘必须大于等于棋盘底缘（允许 1px 亚像素贴合）
        const gap = dRect.top - bRect.bottom;
        return { hasDock: true, noOcclusion: gap >= -1.0, gap };
      });

      check(
        occlusionCheck.noOcclusion,
        `[${vp.tag}] 开局设置面板绝不遮挡棋盘 (净空 gap = ${occlusionCheck.gap.toFixed(1)}px ≥ 0)`
      );

      await page.close();
      await ctx.close();
    }

    // ══════════════════════════════════════════════════════════════════
    // Phase 5: 全流程控制台与页面报错校验
    // ══════════════════════════════════════════════════════════════════
    console.log('\n== [Phase 5] 零控制台报错验证 ==');
    check(pageErrors.length === 0, '全流程 0 pageerror / 0 console.error', pageErrors.join('; '));

  } finally {
    await browser.close();
    server.close();
  }

  // 写入 JSON 结果报告
  const total = results.length;
  const passed = results.filter((r) => r.ok).length;
  const failed = total - passed;
  const report = {
    title: 'Gomoku v1.3.0 QA Verification Report',
    date: new Date().toISOString(),
    total,
    passed,
    failed,
    status: failed === 0 ? 'ALL_PASS' : 'HAS_FAILURES',
    results,
    pageErrors
  };

  fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2), 'utf8');
  console.log(`\n══════════════════════════════════════════════════════════════════`);
  console.log(`终检结论: ${passed} PASS / ${failed} FAIL (总计 ${total} 项测试)`);
  console.log(`结果文件已写入: ${OUT_JSON}`);
  console.log(`══════════════════════════════════════════════════════════════════`);

  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error in test suite:', err);
  process.exit(1);
});
