/**
 * e2e 冒烟测试：用 playwright-core 驱动系统 Edge 验证五子棋页面。
 * 覆盖：首页渲染、人机对局全流程（落子/AI 回应/悔棋/认输/重开）、
 *       建房弹窗、控制台无报错。
 *
 * 运行：node e2e_test.js
 */
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:8123/index.html';
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });

  console.log('\n[1] 首页渲染');
  await page.goto(BASE, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);
  ok(await page.locator('.mode-card').count() === 3, '三张模式卡片');
  ok(await page.locator('.level-btn').count() === 9, '九段段位按钮');
  ok(await page.locator('#view-home').isVisible(), '首页视图可见');
  ok(await page.locator('#board').count() === 1, '棋盘 canvas 元素存在');
  ok(errors.length === 0, '无 JS 报错 (' + errors.join('; ') + ')');

  console.log('\n[2] 人机对战：落子 + AI 回应 + 计时');
  await page.locator('.level-btn[data-level="5"]').click();
  ok(await page.locator('.level-btn[data-level="5"]').evaluate(el => el.classList.contains('active')), '选中 5 段');
  await page.locator('#btn-start-ai').click();
  await page.waitForTimeout(600);
  ok(await page.locator('#view-game').isVisible(), '进入对局视图');
  ok((await page.locator('#game-status').textContent()).includes('轮到你'), '状态条提示轮到你');

  // 点击棋盘中央落子
  const canvas = page.locator('#board');
  const cb = await canvas.boundingBox();
  const c = cb.width / 16; // 15 格 + 两侧留白 = SIZE+1 段
  const px = cb.x + c * 8, py = cb.y + c * 8; // (7,7) 天元
  await page.mouse.click(px, py);
  await page.waitForTimeout(2000); // 等 AI 回应 + 计时走动
  const status = await page.locator('#game-status').textContent();
  ok(status.includes('轮到你'), 'AI 已落子并轮回玩家 (status=' + status + ')');
  const blackClock = await page.locator('#p-black-clock').textContent();
  ok(blackClock !== '00:00', '黑方计时走动 (' + blackClock + ')');

  console.log('\n[3] 悔棋 / 认输 / 重开');
  const undoBtn = page.locator('#btn-undo');
  ok(!(await undoBtn.isDisabled()), '悔棋按钮可用');
  await undoBtn.click();
  await page.waitForTimeout(300);
  ok((await page.locator('#game-status').textContent()).includes('轮到你'), '悔棋后仍轮到你');

  // 人机模式认输：直接判负弹窗（无确认框）
  const resignBtn = page.locator('#btn-resign');
  ok(!(await resignBtn.isDisabled()), '认输按钮可用');
  await resignBtn.click();
  await page.waitForTimeout(400);
  ok((await page.locator('.win-banner .big').textContent()).includes('胜'), '认输后胜负提示出现');

  // 再来一局 → 重开
  await page.locator('[data-again]').click();
  await page.waitForTimeout(400);
  ok((await page.locator('#game-status').textContent()).includes('轮到你'), '重开后新对局开始');

  console.log('\n[4] 建房弹窗（局域网联机入口）');
  await page.locator('#btn-leave').click();
  await page.waitForTimeout(300);
  ok(await page.locator('#view-home').isVisible(), '返回首页');
  await page.locator('#btn-lan-create').click();
  await page.waitForTimeout(300);
  await page.locator('#m-create-ok').click();
  await page.waitForTimeout(2500); // 等 PeerJS 连接信令
  const modalText = await page.locator('.modal-card').textContent().catch(() => '');
  ok(modalText.includes('房间码') || modalText.includes('房间已创建'),
    '建房弹窗出现（房间码 UI）: ' + modalText.slice(0, 60));

  console.log('\n[5] 移动端视口渲染（独立页面，避免弹窗状态污染）');
  const mPage = await ctx.newPage();
  await mPage.setViewportSize({ width: 390, height: 844 });
  await mPage.goto(BASE, { waitUntil: 'networkidle' });
  await mPage.locator('#btn-start-ai').click();
  await mPage.waitForTimeout(800);
  const mBoard = await mPage.locator('.board-wrap').boundingBox();
  ok(mBoard && mBoard.width > 300 && mBoard.width < 390, '移动端棋盘自适应 (w=' + (mBoard && mBoard.width) + ')');
  const mSide = await mPage.locator('.side-panel').boundingBox();
  ok(mSide && mSide.width > 300, '移动端侧栏纵向排列 (w=' + (mSide && mSide.width) + ')');
  // 移动端落子一次
  const mc = await mPage.locator('#board').boundingBox();
  const mcell = mc.width / 16;
  await mPage.mouse.click(mc.x + mcell * 8, mc.y + mcell * 8);
  await mPage.waitForTimeout(1500);
  ok((await mPage.locator('#game-status').textContent()).includes('轮到你'), '移动端落子 + AI 回应正常');

  console.log('\n[6] 最终错误检查');
  ok(errors.length === 0, '全程无 JS 报错 (' + errors.slice(0, 3).join(' | ') + ')');

  await browser.close();
  console.log('\n========== 结果: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(2);
});
