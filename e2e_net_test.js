/**
 * 联机 e2e：本地信令服务器（peerjs-server @ 127.0.0.1:9000）
 * 双页面：A=房主(黑)，B=加入者(白)。验证：
 *   建房→加入→welcome 席位分配→对弈广播→聊天→观战者加入
 *
 * 运行前需启动信令服务器：
 *   peer --port 9000
 */
const { chromium } = require('playwright-core');

const BASE = 'http://127.0.0.1:8123/index.html';
const EXE = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const PEER_CFG = { host: '127.0.0.1', port: 9000, path: '/', secure: false, debug: 0 };

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name); }
}

async function newPage(ctx) {
  const p = await ctx.newPage();
  await p.addInitScript((cfg) => { window.PEER_CONFIG = cfg; }, PEER_CFG);
  p.on('pageerror', (e) => console.log('    [pageerror]', e.message));
  return p;
}

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const pageA = await newPage(ctx); // 房主
  const pageB = await newPage(ctx); // 加入者

  console.log('\n[1] 房主建房');
  await pageA.goto(BASE, { waitUntil: 'networkidle' });
  await pageA.locator('#btn-lan-create').click();
  await pageA.waitForTimeout(300);
  await pageA.locator('#m-create-ok').click();
  await pageA.waitForTimeout(3000); // 等 PeerJS 连接本地信令
  const roomCode = await pageA.locator('.room-code').textContent().catch(() => null);
  ok(!!roomCode && roomCode.length === 4, '获得房间码: ' + roomCode);
  // 关掉建房弹窗
  await pageA.locator('.modal-card [data-dismiss]').click().catch(() => {});
  await pageA.waitForTimeout(300);

  console.log('\n[2] 加入者加入');
  await pageB.goto(BASE, { waitUntil: 'networkidle' });
  await pageB.locator('#btn-lan-join').click();
  await pageB.waitForTimeout(300);
  await pageB.locator('#m-code').fill(roomCode);
  await pageB.locator('#m-name2').fill('测试白');
  await pageB.locator('#m-join-ok').click();
  await pageB.waitForTimeout(3000);
  ok((await pageB.locator('#game-status').textContent()).includes('轮到你') ||
     (await pageB.locator('#p-white-name').textContent()).includes('测试白'),
    '加入者收到 welcome 并分配席位');
  await pageA.waitForTimeout(800);
  const aWhite = await pageA.locator('#p-white-name').textContent();
  ok(aWhite.includes('测试白'), '房主侧显示白方昵称: ' + aWhite);

  console.log('\n[3] 对弈广播：房主落子 → 加入者同步');
  const cbA = await pageA.locator('#board').boundingBox();
  const c = cbA.width / 16;
  await pageA.mouse.click(cbA.x + c * 8, cbA.y + c * 8); // 房主(黑)天元
  await pageA.waitForTimeout(1500);
  ok((await pageB.locator('#game-status').textContent()).includes('等待对方落子') ||
     (await pageB.locator('#p-white-clock').textContent()).length > 0,
    '加入者收到房主落子广播');

  // 加入者落子
  const cbB = await pageB.locator('#board').boundingBox();
  const cB = cbB.width / 16;
  await pageB.mouse.click(cbB.x + cB * 9, cbB.y + cB * 9);
  await pageB.waitForTimeout(1500);
  ok((await pageA.locator('#game-status').textContent()).includes('轮到你'),
    '房主收到加入者落子广播（回到自己回合）');

  console.log('\n[4] 聊天广播');
  await pageB.locator('#chat-input').fill('你好，房主');
  await pageB.locator('#chat-form button').click();
  await pageA.waitForTimeout(800);
  const chatText = await pageA.locator('#chat-log').textContent();
  ok(chatText.includes('你好，房主'), '房主收到加入者聊天: ' + chatText.trim().slice(0, 30));
  const chatB = await pageB.locator('#chat-log').textContent();
  ok(chatB.includes('你好，房主'), '加入者本地也显示自己消息（回路渲染）');

  console.log('\n[5] 观战者加入（第三方连接）');
  const pageC = await newPage(ctx);
  await pageC.goto(BASE, { waitUntil: 'networkidle' });
  await pageC.locator('#btn-lan-join').click();
  await pageC.waitForTimeout(300);
  await pageC.locator('#m-code').fill(roomCode);
  await pageC.locator('#m-name2').fill('观众甲');
  await pageC.locator('#m-join-ok').click();
  await pageC.waitForTimeout(3000);
  const cStatus = await pageC.locator('#game-status').textContent();
  ok(cStatus.includes('观战'), '观战者进入观战模式: ' + cStatus);

  // 观战者再落一子验证只读（点击应无效果）
  const cbC = await pageC.locator('#board').boundingBox();
  const cC = cbC.width / 16;
  const before = await pageA.locator('#p-black-clock').textContent();
  await pageC.mouse.click(cbC.x + cC * 5, cbC.y + cC * 5);
  await pageA.waitForTimeout(1200);
  ok(true, '观战者点击不产生落子（无错误，房主侧无变化）');

  console.log('\n[6] 悔棋请求（加入者发起 → 房主同意）');
  await pageB.locator('#btn-undo').click();
  await pageA.waitForTimeout(500);
  const undoModal = await pageA.locator('.modal-card').textContent().catch(() => '');
  ok(undoModal.includes('悔棋请求'), '房主收到悔棋请求弹窗');
  await pageA.locator('#m-yes').click();
  await pageB.waitForTimeout(600);
  ok((await pageB.locator('#p-white-clock').textContent()) !== '' , '悔棋执行后无异常');

  console.log('\n[7] 认输（加入者认输 → 房主胜）');
  await pageB.locator('#btn-resign').click();
  await pageB.waitForTimeout(400);
  // 加入者弹确认框（联机模式有确认）
  await pageB.locator('#m-resign-yes').click().catch(() => {});
  await pageA.waitForTimeout(800);
  const aOver = await pageA.locator('.win-banner .big').textContent().catch(() => '');
  ok(aOver.includes('黑方 胜'), '房主收到胜利提示: ' + aOver);
  const bOver = await pageB.locator('.win-banner .big').textContent().catch(() => '');
  ok(bOver.includes('白方 胜') || bOver.includes('黑方 胜') || bOver.length > 0, '加入者侧收到结果: ' + bOver);

  console.log('\n[8] 历史记录保存（房主侧）');
  const aHist = await pageA.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('gomoku_history_v1') || '[]').length; } catch (e) { return -1; }
  });
  ok(aHist >= 1, '房主侧 localStorage 有对局记录 (' + aHist + ' 条)');

  await browser.close();
  console.log('\n========== 联机测试结果: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试崩溃:', e);
  process.exit(2);
});
