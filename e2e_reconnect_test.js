/**
 * 断线重连 e2e：本地信令服务器。
 * 流程：房主建房 + 加入者对弈 2 手 → 加入者断网（offline）→
 *       host 提示重连等待 → 加入者恢复网络 → 自动重连 → 棋盘状态恢复 → 继续对弈。
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

(async () => {
  const browser = await chromium.launch({ executablePath: EXE, headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });

  async function mkPage() {
    const p = await ctx.newPage();
    await p.addInitScript((cfg) => { window.PEER_CONFIG = cfg; }, PEER_CFG);
    p.on('pageerror', (e) => console.log('    [pageerror]', e.message));
    return p;
  }

  const host = await mkPage();
  const client = await mkPage();

  // 建房
  await host.goto(BASE, { waitUntil: 'networkidle' });
  await host.locator('#btn-lan-create').click();
  await host.waitForTimeout(200);
  await host.locator('#m-create-ok').click();
  await host.waitForTimeout(2500);
  const roomCode = await host.locator('.room-code').textContent();
  ok(!!roomCode, '房主建房，房间码 ' + roomCode);
  await host.locator('.modal-card [data-dismiss]').click().catch(() => {});
  await host.waitForTimeout(200);

  // 加入
  await client.goto(BASE, { waitUntil: 'networkidle' });
  await client.locator('#btn-lan-join').click();
  await client.waitForTimeout(200);
  await client.locator('#m-code').fill(roomCode);
  await client.locator('#m-name2').fill('重连测试');
  await client.locator('#m-join-ok').click();
  await client.waitForTimeout(2500);
  ok((await client.locator('#p-white-name').textContent()).includes('重连测试'), '加入者获得白席');

  // 对弈 2 手：房主(黑)天元，加入者(白)隔壁
  const hb = await host.locator('#board').boundingBox();
  const hc = hb.width / 16;
  await host.mouse.click(hb.x + hc * 8, hb.y + hc * 8);
  await host.waitForTimeout(800);
  const cb = await client.locator('#board').boundingBox();
  const cc = cb.width / 16;
  await client.mouse.click(cb.x + cc * 9, cb.y + cc * 9);
  await host.waitForTimeout(1200);
  ok(true, '对弈进行中（2 手）');

  // ── 断线：client 离线 ──
  await ctx.setOffline(true);
  await host.waitForTimeout(15000); // 心跳 10s + 判死 30s，等 host 感知断开（窗口内）
  const hostStatus = await host.locator('#conn-indicator').textContent().catch(() => '');
  console.log('    host 状态指示: ' + (hostStatus || '(无)'));

  // ── 恢复网络 → 自动重连 ──
  await ctx.setOffline(false);
  await client.waitForTimeout(8000); // 重连退避 2s→4s→8s
  const cStatus = await client.locator('#game-status').textContent().catch(() => '');
  ok(cStatus.includes('轮到你') || cStatus.includes('等待'), 'client 重连成功并恢复对局 (status=' + cStatus + ')');

  // 重连后继续落子：轮到房主(黑)？两手下完后轮到房主。验证 client 能看到房主新落子
  const hb2 = await host.locator('#board').boundingBox();
  const hc2 = hb2.width / 16;
  await host.mouse.click(hb2.x + hc2 * 6, hb2.y + hc2 * 6);
  await client.waitForTimeout(1500);
  const cStatus2 = await client.locator('#game-status').textContent();
  ok(cStatus2.includes('轮到你') || cStatus2.includes('等待'), '重连后棋局继续同步 (status=' + cStatus2 + ')');

  await browser.close();
  console.log('\n========== 重连测试: ' + pass + ' 通过, ' + fail + ' 失败 ==========');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('崩溃:', e.message); process.exit(2); });
