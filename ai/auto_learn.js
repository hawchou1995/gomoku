/**
 * 自动训练守护进程（全自动闭环）：
 *   浏览器每局结束导出棋谱 → 本进程自动检测 → 复制到 model/games/ →
 *   空闲 N 秒后自动跑 learn.py（复盘学习 + 胜率门控 + 模型导出）→ 浏览器刷新后生效。
 *
 * 用法：node ai/auto_learn.js
 *   默认监控：浏览器下载目录（Downloads/Chrome）+ model/games/（手动放入也可）
 *   可用环境变量 GOMOKU_DOWNLOAD_DIR 覆盖下载目录路径。
 *
 * 可选参数：
 *   --learn-every 30    空闲秒数（默认 30，即 30 秒无新棋谱后训练一次）
 *   --min-games 1       最少新棋谱数才触发训练（默认 1）
 *   --once              处理当前已有棋谱后退出（不常驻）
 */
'use strict';
var fs = require('fs');
var path = require('path');
var os = require('os');
var child = require('child_process');

var GOMOKU = path.resolve(__dirname, '..');
var GAMES_DIR = path.join(GOMOKU, 'model', 'games');
var DONE_DIR = path.join(GAMES_DIR, 'done');
var PY = 'C:/Users/XAUTHUB/.workbuddy/binaries/python/versions/3.13.12/python.exe';
if (!fs.existsSync(PY)) PY = 'python'; // 回退系统 python

// 默认监控目录：Downloads/Chrome（浏览器默认下载位置）
var DOWNLOAD_DIR = process.env.GOMOKU_DOWNLOAD_DIR ||
  path.join(os.homedir(), 'Downloads', 'Chrome');
if (!fs.existsSync(DOWNLOAD_DIR)) DOWNLOAD_DIR = path.join(os.homedir(), 'Downloads');

var LEARN_EVERY = 30;      // 空闲秒数
var MIN_GAMES = 1;         // 最少新棋谱数
var ONCE = process.argv.indexOf('--once') >= 0;
process.argv.forEach(function (a, i) {
  if (a === '--learn-every' && process.argv[i + 1]) LEARN_EVERY = parseInt(process.argv[i + 1], 10);
  if (a === '--min-games' && process.argv[i + 1]) MIN_GAMES = parseInt(process.argv[i + 1], 10);
  if (a === '--once') ONCE = true;
});

var seen = {};      // 已见过的文件（去重）
var pending = [];   // 待学习棋谱
var lastActivity = Date.now();
var learning = false;
var learnedTotal = 0;

function listJson(dir) {
  try {
    return fs.readdirSync(dir).filter(function (f) { return /\.json$/i.test(f); })
      .map(function (f) { return path.join(dir, f); });
  } catch (e) { return []; }
}

function scan() {
  var sources = [DOWNLOAD_DIR, GAMES_DIR].filter(function (d) { return d !== GAMES_DIR || true; });
  // 下载目录 + games 目录都扫（games 里 done/ 子目录跳过）
  var found = [];
  [DOWNLOAD_DIR, GAMES_DIR].forEach(function (dir) {
    listJson(dir).forEach(function (f) {
      if (path.dirname(f).indexOf('done') >= 0) return;
      var key = fs.statSync(f).mtimeMs + '|' + path.basename(f);
      if (seen[key]) return;
      seen[key] = true;
      if (!/gomoku-game-/.test(path.basename(f)) && path.dirname(f) === GAMES_DIR) {
        // games 目录里的非标准名 json 也算（手动放入的）
      } else if (!/gomoku-game-/.test(path.basename(f))) {
        return; // 下载目录里只认 gomoku-game-* 棋谱
      }
      found.push(f);
    });
  });
  if (found.length) {
    found.forEach(function (f) {
      var dest = path.join(GAMES_DIR, path.basename(f));
      try {
        if (path.dirname(f) !== GAMES_DIR) fs.copyFileSync(f, dest);
        pending.push(dest);
        console.log('📥 发现新棋谱: ' + path.basename(f));
      } catch (e) {
        console.log('⚠ 复制失败: ' + path.basename(f) + ' — ' + e.message);
      }
    });
    lastActivity = Date.now();
  }
}

function maybeLearn() {
  if (learning || pending.length < MIN_GAMES) return;
  if (Date.now() - lastActivity < LEARN_EVERY * 1000) return; // 还在来棋谱，等一会
  learning = true;
  var batch = pending.slice();
  pending = [];
  console.log('\n🧠 开始复盘学习（' + batch.length + ' 局新棋谱）…');
  var t0 = Date.now();
  var p = child.spawn(PY, [path.join(GOMOKU, 'ai', 'learn.py'), '--epochs', '3', '--eval', '4'], {
    cwd: path.join(GOMOKU, 'ai'),
    stdio: 'inherit'
  });
  p.on('close', function (code) {
    learning = false;
    if (code === 0) {
      learnedTotal += batch.length;
      // 导出浏览器模型（best_net.js，file:// 环境全局注入）
      var ex = child.spawnSync(PY, [path.join(GOMOKU, 'ai', 'export.py')], { stdio: 'inherit' });
      console.log('✅ 学习完成（' + ((Date.now() - t0) / 1000).toFixed(0) + 's），累计学习 ' + learnedTotal +
        ' 局 — 浏览器刷新后新模型生效\n');
    } else {
      console.log('⚠ 学习进程异常退出（code ' + code + '），棋谱保留在 model/games/ 可重试\n');
      pending = pending.concat(batch);
    }
    if (ONCE) process.exit(0);
  });
}

console.log('════════ 五子棋自动训练守护 ════════');
console.log('监控目录: ' + DOWNLOAD_DIR);
console.log('棋谱目录: ' + GAMES_DIR);
console.log('策略: 每 ' + LEARN_EVERY + 's 空闲 + 至少 ' + MIN_GAMES + ' 局新棋谱 → 自动 learn.py\n');
console.log('浏览器对局结束会自动下载棋谱，本进程将自动接手训练。\n');

// 首次扫描：把已有棋谱也纳入（只学一次）
scan();

if (ONCE) {
  // 一次性模式：学完退出
  maybeLearn();
  var onceTimer = setInterval(function () {
    if (!learning && pending.length === 0) { clearInterval(onceTimer); process.exit(0); }
  }, 2000);
} else {
  setInterval(function () { scan(); maybeLearn(); }, 3000);
  // 也响应文件系统事件（更快）
  try {
    var dirs = [DOWNLOAD_DIR, GAMES_DIR];
    dirs.forEach(function (d) {
      if (!fs.existsSync(d)) return;
      fs.watch(d, { persistent: false }, function () { scan(); });
    });
  } catch (e) { /* watch 失败靠轮询兜底 */ }
}
