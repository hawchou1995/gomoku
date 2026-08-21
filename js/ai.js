/**
 * ai.js — 五子棋 AI（一至九段）v3
 *
 * v3 重写（针对九段棋力弱的重构）：
 *   - 精确威胁分类：落子后逐方向识别 五连/活四/冲四/活三/眠三/活二
 *   - 威胁决策层：搜索前先判定 必胜 > 必防 > 强攻，杜绝"抓不到杀着/不防守"类失误
 *   - killer move + 历史表启发：α-β 剪枝效率大幅提升，同时间预算下搜得更深
 *   - 搜索内威胁截断：每个节点先做一步必胜/必防检测，缩短杀棋路径
 *   - 评估升级：模式分 + 双方威胁计数差值（活三/冲四/活四数量）+ 位置权值
 *   - 禁手感知：AI 执黑时正确过滤 三三/四四/长连，且黑棋双活三不算必胜点
 *   - 候选池扩大（九段 30 点），威胁点强制并入
 *
 * 纯逻辑实现，兼容浏览器 / Node 双环境。API 保持 v2 兼容：
 *   AI.getBestMove(board, player, level, deadline, forbidEnabled) → {x, y}
 */
(function (global) {
  'use strict';

  var E = global.GomokuEngine;
  var SIZE = E.SIZE, EMPTY = E.EMPTY, BLACK = E.BLACK, WHITE = E.WHITE;
  var get = E.get, set = E.set, inB = E.inB, opp = E.opp;

  var DIRS = [[1, 0], [0, 1], [1, 1], [1, -1]];

  // ── Zobrist 哈希 + 置换表（2026-08-16 激进重构）──
  // 消除换序/重复局面的冗余搜索，是加深深度的前提。棋盘 3 态 × 225 格 × 2 颜色。
  var ZOBRIST = (function () {
    var seed = 123456789;
    function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }
    var t = new Array(2);
    for (var p = 0; p < 2; p++) {
      t[p] = new Float64Array(SIZE * SIZE);
      for (var i = 0; i < SIZE * SIZE; i++) t[p][i] = Math.floor(rnd() * 0xFFFFFFFF);
    }
    return t; // t[0]=黑哈希 t[1]=白哈希（用 p-1 索引）
  })();

  function zobristHash(board) {
    var h = 0;
    for (var i = 0; i < SIZE * SIZE; i++) {
      var v = board[i];
      if (v === EMPTY) continue;
      h ^= ZOBRIST[v - 1][i];
    }
    return h >>> 0; // 归一为 uint32
  }

  // ── 分值表 ──
  var SCORE = {
    WIN: 10000000,
    LIVE4: 1000000,   // 活四（必胜）
    RUSH4: 100000,    // 冲四
    LIVE3: 10000,     // 活三
    SLEEP3: 1000,     // 眠三
    LIVE2: 300,       // 活二
    SLEEP2: 100       // 眠二
  };

  // ── 位置权值矩阵（15×15，中心高，边缘低）──
  var POS_WEIGHT = (function () {
    var w = new Float32Array(225);
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var d = Math.max(Math.abs(x - 7), Math.abs(y - 7));
        w[y * SIZE + x] = 1.0 - d * 0.055; // 中心 1.0，角落 0.56
      }
    }
    return w;
  })();

  /** 时间预算（毫秒）：段位越高思考越久。九段 6.5s（Web Worker 异步执行，主线程不卡）。 */
  var TIME_BUDGETS = [900, 900, 1100, 1300, 1500, 1800, 2200, 2800, 6500];

  var LEVELS = [
    { depth: 1, cand: 12, noise: 0.20, threat: 0 },  // 1 段
    { depth: 1, cand: 14, noise: 0.12, threat: 0 },  // 2 段
    { depth: 2, cand: 16, noise: 0.06, threat: 1 },  // 3 段
    { depth: 2, cand: 18, noise: 0.03, threat: 1 },  // 4 段
    { depth: 3, cand: 20, noise: 0.01, threat: 2 },  // 5 段
    { depth: 4, cand: 22, noise: 0,    threat: 2 },  // 6 段
    { depth: 4, cand: 24, noise: 0,    threat: 3 },  // 7 段
    { depth: 5, cand: 26, noise: 0,    threat: 3 },  // 8 段
    { depth: 14, cand: 36, noise: 0,   threat: 4 }   // 9 段（2026-08-18：depth 8→14，cand 30→36，预算 3.5s→6.5s 走 Worker；历史启发接入后同样预算搜得更深）
  ];

  /**
   * 单方向形状分析（含跳形）。
   * 返回 { count, jumpL, jumpR, openL, openR, jumpOpenL, jumpOpenR }
   *   count: 连续段长（含落点）
   *   jumpL/jumpR: 连续段外侧隔一空后的跳段子数（左/右）
   *   openL/openR: 连续段两端是否开放（紧邻为空）
   *   jumpOpenL/jumpOpenR: 跳段外端是否开放
   * 判定规则：线两端开放度 = 连续段外侧开放 + 跳段外开放（跳段与连续段之间的空是内部空，不算开放端）。
   */
  function shapeInfo(board, x, y, player, dx, dy) {
    var count = 1;
    var openL = 0, openR = 0, jumpL = 0, jumpR = 0, jumpOpenL = 0, jumpOpenR = 0;
    // +方向（右）
    var nx = x + dx, ny = y + dy;
    while (inB(nx, ny) && get(board, nx, ny) === player) { count++; nx += dx; ny += dy; }
    if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
      openR = 1;
      var gx = nx + dx, gy = ny + dy;
      while (inB(gx, gy) && get(board, gx, gy) === player) { jumpR++; gx += dx; gy += dy; }
      if (inB(gx, gy) && get(board, gx, gy) === EMPTY) jumpOpenR = 1;
    }
    // -方向（左）
    nx = x - dx; ny = y - dy;
    while (inB(nx, ny) && get(board, nx, ny) === player) { count++; nx -= dx; ny -= dy; }
    if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
      openL = 1;
      gx = nx - dx; gy = ny - dy;
      while (inB(gx, gy) && get(board, gx, gy) === player) { jumpL++; gx -= dx; gy -= dy; }
      if (inB(gx, gy) && get(board, gx, gy) === EMPTY) jumpOpenL = 1;
    }
    return { count: count, jumpL: jumpL, jumpR: jumpR, openL: openL, openR: openR, jumpOpenL: jumpOpenL, jumpOpenR: jumpOpenR };
  }

  /**
   * 在 (x,y) 放置 player 后，四方向形状分类（含跳三/跳四）。
   * 返回 { win, live4, rush4, live3, sleep3, live2 } 各类数量。
   */
  function classifyPoint(board, x, y, player) {
    set(board, x, y, player);
    var c = { win: 0, live4: 0, rush4: 0, live3: 0, sleep3: 0, live2: 0 };
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var s = shapeInfo(board, x, y, player, dx, dy);
      if (s.count >= 5) { c.win++; continue; } // 纯连续五连才判胜；跳形不算一步胜
      var jumpTotal = s.jumpL + s.jumpR;
      var total = s.count + jumpTotal;
      // 连续段自身已四连：威胁由连续段开放端决定（外侧跳子只是附加子，不参与判定）。
      // 【2026-08-16 修复①】此前落入跳形分支，连续四连+双端开放+外侧跳子被误判为冲四：
      // 活四成型点漏报 force → 棋谱12 黑 E13（D14-E13-F12-G11 双端开）被判 rush4，
      // AI 只防了 N7 双冲四、对 E13 活四威胁视而不见。
      // 【2026-08-16 修复②】openCnt4===0（双端堵死）必须判死四（无威胁）——
      // 此前误判 rush4 → 棋谱15 白 J7（G7-H7-I7-J7 双端 F7/K7 黑堵）被判假双冲四，
      // AI 以为必胜结果白送一手，反给黑方制造子力。
      if (s.count === 4) {
        var openCnt4 = (s.openL ? 1 : 0) + (s.openR ? 1 : 0);
        if (openCnt4 >= 2) c.live4++;
        else if (openCnt4 === 1) c.rush4++;
        // openCnt4 === 0 → 死四，无威胁
        continue;
      }
      // 两端开放：连续段开放端 + 跳段外开放端（同一侧连续开放与跳段开放互斥）
      var open = 0;
      if (s.jumpL > 0) { if (s.jumpOpenL) open++; }
      else if (s.openL) open++;
      if (s.jumpR > 0) { if (s.jumpOpenR) open++; }
      else if (s.openR) open++;
      if (jumpTotal > 0) {
        // 跳形：只有一个 gap 成五点
        //   total=4 → 跳四：补 gap 直接五连 → 冲四级（唯一成五点，须堵 gap）
        //   total=3 → 跳三：补 gap 成活四 → 活三级（open=2）或眠三（open=1）
        //   total=2 → 跳二
        if (total >= 4) c.rush4++;
        else if (total === 3) { if (open === 2) c.live3++; else if (open === 1) c.sleep3++; }
        else if (total === 2 && open === 2) c.live2++;
      } else {
        // 纯连续段
        if (total === 4) {
          if (open >= 2) c.live4++;
          else if (open === 1) c.rush4++;
        }
        else if (total === 3) {
          if (open === 2) c.live3++;
          else if (open === 1) c.sleep3++;
        }
        else if (total === 2 && open === 2) c.live2++;
      }
    }
    set(board, x, y, EMPTY);
    return c;
  }

  /**
   * 一步威胁等级：判断该点是否是"必胜点"或"强威胁点"。
   * isBlackForbid：落子方是黑棋且禁手开启（黑棋双活三/双冲四为禁手，不算必胜）。
   * 返回 { win, force, forceRank, strong }：
   *   forceRank 用于多个必防点共存时选最紧急的（活四 > 双冲四/冲四活三 > 双活三）。
   */
  function threatLevel(c, isBlackForbid) {
    var force = false, forceRank = 0, strong = false;
    if (c.win > 0) { force = true; forceRank = 5; }
    else if (c.live4 > 0) { force = true; forceRank = 4; }        // 活四：立即无解
    else if (c.rush4 >= 2) { force = !isBlackForbid; forceRank = force ? 3 : 0; } // 双冲四：黑棋禁手
    else if (c.rush4 >= 1 && c.live3 >= 1) { force = true; forceRank = 3; } // 冲四活三（四三非禁手）
    else if (c.live3 >= 2) { force = !isBlackForbid; forceRank = force ? 2 : 0; } // 双活三：黑棋禁手
    else if (c.live3 >= 1) strong = true;
    else if (c.rush4 >= 1) strong = true;
    return { win: c.win > 0, force: force, forceRank: forceRank, strong: strong };
  }

  /** 该点落黑子是否禁手（长连/三三/四四）。 */
  function isForbidMove(board, x, y) {
    set(board, x, y, BLACK);
    var isF = false;
    // 长连
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var cnt = 1;
      var nx = x + dx, ny = y + dy;
      while (inB(nx, ny) && get(board, nx, ny) === BLACK) { cnt++; nx += dx; ny += dy; }
      nx = x - dx; ny = y - dy;
      while (inB(nx, ny) && get(board, nx, ny) === BLACK) { cnt++; nx -= dx; ny -= dy; }
      if (cnt >= 6) { isF = true; break; }
    }
    if (!isF) {
      var live3 = 0, live4 = 0;
      for (d = 0; d < 4; d++) {
        dx = DIRS[d][0]; dy = DIRS[d][1];
        cnt = 1; var open = 0;
        nx = x + dx; ny = y + dy;
        while (inB(nx, ny) && get(board, nx, ny) === BLACK) { cnt++; nx += dx; ny += dy; }
        if (inB(nx, ny) && get(board, nx, ny) === EMPTY) open++;
        nx = x - dx; ny = y - dy;
        while (inB(nx, ny) && get(board, nx, ny) === BLACK) { cnt++; nx -= dx; ny -= dy; }
        if (inB(nx, ny) && get(board, nx, ny) === EMPTY) open++;
        if (cnt === 4 && open === 2) live4++;
        if (cnt === 3 && open === 2) live3++;
        if (cnt === 4 && open === 1) live4++;
      }
      if (live3 >= 2 || live4 >= 2) isF = true;
    }
    set(board, x, y, EMPTY);
    return isF;
  }

  /**
   * VCF（连续冲四必胜）搜索：
   * 我冲四 → 对方被迫堵缺口 → 我再冲四 → … → 五连。
   * 返回致胜首步 {x,y}，无杀返回 null。
   * depth：剩余我方落子次数（初始 4 = 三次冲四 + 收网）。
   */
  function vcfSearch(board, me, depth, forbidEnabled, dl) {
    if (Date.now() > dl) return null;
    var near = collectNear(board);
    var meBlackForbid = forbidEnabled && me === BLACK;
    var rushPts = [];
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      if (meBlackForbid && isForbidMove(board, x, y)) continue;
      var c = classifyPoint(board, x, y, me);
      if (c.win > 0 || c.live4 > 0) return { x: x, y: y }; // 一步成五/活四
      if (c.rush4 > 0) rushPts.push([x, y]);
    }
    if (depth <= 1 || rushPts.length === 0) return null;
    for (var j = 0; j < rushPts.length; j++) {
      var px = rushPts[j][0], py = rushPts[j][1];
      set(board, px, py, me); // 我方落冲四子（必须落盘，递归层才能看到）
      var gaps = rushGapsOf(board, px, py, me);
      for (var g = 0; g < gaps.length; g++) {
        var gx = gaps[g][0], gy = gaps[g][1];
        set(board, gx, gy, opp(me)); // 对方必堵缺口
        var sub = vcfSearch(board, me, depth - 1, forbidEnabled, dl);
        set(board, gx, gy, EMPTY);
        if (sub) { set(board, px, py, EMPTY); return { x: px, y: py }; }
      }
      set(board, px, py, EMPTY);
    }
    return null;
  }

  /**
   * 收集 (x,y) 落 me 后所有"冲四缺口"（对方唯一能堵的点）。
   * 支持连续冲四（XXXX_）与跳四（X_XXX / XX_X_等，缺口为中间空位）。
   */
  function rushGapsOf(board, x, y, me) {
    var orig = get(board, x, y);
    set(board, x, y, me);
    var gaps = [], seen = {};
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      // 连续段（+/- 两侧）
      var cntR = 0, cntL = 0, jumpR = 0, jumpL = 0;
      var gapR = null, gapL = null;
      var nx = x + dx, ny = y + dy;
      while (inB(nx, ny) && get(board, nx, ny) === me) { cntR++; nx += dx; ny += dy; }
      if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
        gapR = { x: nx, y: ny };
        var gx = nx + dx, gy = ny + dy;
        while (inB(gx, gy) && get(board, gx, gy) === me) { jumpR++; gx += dx; gy += dy; }
      }
      nx = x - dx; ny = y - dy;
      while (inB(nx, ny) && get(board, nx, ny) === me) { cntL++; nx -= dx; ny -= dy; }
      if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
        gapL = { x: nx, y: ny };
        gx = nx - dx; gy = ny - dy;
        while (inB(gx, gy) && get(board, gx, gy) === me) { jumpL++; gx -= dx; gy -= dy; }
      }
      // 缺口判定：补 gap 后该方向是否形成五连
      // 右侧跳段：补 gapR → jumpR+1+cntR+1+cntL ≥ 5 → jumpR+cntR+cntL ≥ 3
      if (gapR && jumpR > 0 && (jumpR + cntR + cntL) >= 3) {
        var k = gapR.x + ',' + gapR.y;
        if (!seen[k]) { seen[k] = 1; gaps.push([gapR.x, gapR.y]); }
      }
      // 左侧跳段同理
      if (gapL && jumpL > 0 && (jumpL + cntR + cntL) >= 3) {
        k = gapL.x + ',' + gapL.y;
        if (!seen[k]) { seen[k] = 1; gaps.push([gapL.x, gapL.y]); }
      }
      // 纯连续四连：cntR+cntL+1 == 4，仅一端开放（另一端被堵/边界）→ 缺口=开放端
      if (cntR + cntL + 1 === 4) {
        var openR = gapR && jumpR === 0;
        var openL = gapL && jumpL === 0;
        if (openR && !openL && gapR) {
          k = gapR.x + ',' + gapR.y;
          if (!seen[k]) { seen[k] = 1; gaps.push([gapR.x, gapR.y]); }
        }
        if (openL && !openR && gapL) {
          k = gapL.x + ',' + gapL.y;
          if (!seen[k]) { seen[k] = 1; gaps.push([gapL.x, gapL.y]); }
        }
      }
    }
    set(board, x, y, orig); // 恢复原值（调用方可能已先落子）
    return gaps;
  }

  /** 找所有距离已有棋子 ≤2 的空点（切比雪夫距离）。 */
  function collectNear(board) {
    var pts = [];
    var seen = {};
    for (var i = 0; i < SIZE; i++) {
      for (var j = 0; j < SIZE; j++) {
        if (get(board, i, j) !== EMPTY) {
          for (var dx = -2; dx <= 2; dx++) {
            for (var dy = -2; dy <= 2; dy++) {
              var nx = i + dx, ny = j + dy;
              if (inB(nx, ny) && get(board, nx, ny) === EMPTY) {
                var k = nx + ',' + ny;
                if (!seen[k]) { seen[k] = 1; pts.push([nx, ny]); }
              }
            }
          }
        }
      }
    }
    return pts;
  }

  /**
   * 候选点生成 + 排序（v3）：
   * 启发分 = 己方威胁等级 × 大权重 + 对方威胁等级 × 0.92 + 位置权值。
   * 强制把"对方强威胁点"（活三/冲四成型点）排到最前，确保防守不遗漏。
   */
  function genCandidates(board, me, near, maxCand, forbidEnabled) {
    var you = opp(me);
    var meBlackForbid = forbidEnabled && me === BLACK;
    var youBlackForbid = forbidEnabled && you === BLACK;
    var scored = [];
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      if (meBlackForbid && isForbidMove(board, x, y)) continue; // 我方禁手点不候选
      var mc = classifyPoint(board, x, y, me);
      var oc = classifyPoint(board, x, y, you);
      var ml = threatLevel(mc, meBlackForbid);
      var ol = threatLevel(oc, youBlackForbid);
      var s = 0;
      // 威胁排序：五连 > 必胜组合 > 强威胁（攻防各自分级，五连绝对优先）
      if (ml.win) s += 2000000;
      else if (ml.force) s += 1000000;
      else if (ml.strong) s += 300000;
      if (ol.win) s += 1840000;         // 对方一步五连：绝对优先于任何强威胁
      else if (ol.force) s += 920000;
      else if (ol.strong) s += 276000;
      s += mc.win * 10000 + mc.live4 * 8000 + mc.rush4 * 3000 + mc.live3 * 4000 + mc.sleep3 * 300;
      s += oc.rush4 * 2500 + oc.live3 * 1000;
      s += POS_WEIGHT[y * SIZE + x] * 50;
      scored.push({ x: x, y: y, s: s });
    }
    scored.sort(function (a, b) { return b.s - a.s; });
    var out = [];
    for (i = 0; i < scored.length && i < maxCand; i++) out.push(scored[i]);
    return out;
  }

  /**
   * 整盘评估 v3.1：逐线形状分（含跳形）+ 双方威胁计数差值 + 位置权值。
   * 与 classifyPoint 使用同一套 shapeInfo 逻辑，保证搜索看到的威胁与决策层一致。
   */
  function evaluateBoard(board, me) {
    var score = 0;
    var myT = { live4: 0, rush4: 0, live3: 0, sleep3: 0, live2: 0 };
    var opT = { live4: 0, rush4: 0, live3: 0, sleep3: 0, live2: 0 };
    for (var y = 0; y < SIZE; y++) {
      for (var x = 0; x < SIZE; x++) {
        var p = get(board, x, y);
        if (p === EMPTY) continue;
        var sign = p === me ? 1 : -1;
        var v = 0;
        for (var d = 0; d < 4; d++) {
          var dx = DIRS[d][0], dy = DIRS[d][1];
          var prevX = x - dx, prevY = y - dy;
          if (inB(prevX, prevY) && get(board, prevX, prevY) === p) continue; // 只计段首
          var s = shapeInfo(board, x, y, p, dx, dy);
          if (s.count >= 5) { v += SCORE.WIN; if (p === me) myT.live4++; else opT.live4++; continue; }
          var jumpTotal = s.jumpL + s.jumpR;
          var total = s.count + jumpTotal;
          var open = 0;
          if (s.jumpL > 0) { if (s.jumpOpenL) open++; }
          else if (s.openL) open++;
          if (s.jumpR > 0) { if (s.jumpOpenR) open++; }
          else if (s.openR) open++;
          if (jumpTotal > 0) {
            // 跳形：与 classifyPoint 同规则。但【2026-08-16 跳三降级】跳三（隔空跳、
            // 需补 gap 才连长）威胁远弱于连续活三——连续活三两端紧邻空位、对手堵一头
            // 我仍能从另一头活四；跳三只有一个补 gap 点，对手堵 gap 即废。
            // 根因实测：黑 9 vs 白 6，落 H10 孤点因凑出"跳活三"被评得高于落 H7 的
            // "连续活三"（50513 vs 45004），黑方四处撒孤点、不延主线，24 手被白斜线杀。
            // 修复：跳三按眠三（SLEEP3）计分，不再与连续活三同档；连续活三才 LIVE3。
            if (total >= 4) { v += SCORE.RUSH4; if (p === me) myT.rush4++; else opT.rush4++; }
            else if (total === 3) {
              v += SCORE.SLEEP3; // 跳三：降为眠三档，弱于连续活三
              if (p === me) myT.sleep3++; else opT.sleep3++;
            }
            else if (total === 2 && open === 2) { v += SCORE.LIVE2; if (p === me) myT.live2++; else opT.live2++; }
          } else {
            if (total === 4) {
              if (open >= 2) { v += SCORE.LIVE4; if (p === me) myT.live4++; else opT.live4++; }
              else if (open === 1) { v += SCORE.RUSH4; if (p === me) myT.rush4++; else opT.rush4++; }
            }
            else if (total === 3) {
              if (open === 2) { v += SCORE.LIVE3; if (p === me) myT.live3++; else opT.live3++; }
              else if (open === 1) { v += SCORE.SLEEP3; if (p === me) myT.sleep3++; else opT.sleep3++; }
            }
            else if (total === 2) {
              if (open === 2) { v += SCORE.LIVE2; if (p === me) myT.live2++; else opT.live2++; }
              else v += SCORE.SLEEP2;
            }
          }
          score += sign * v * POS_WEIGHT[y * SIZE + x];
        }
      }
    }
    // 威胁计数差值（活四无解近乎必胜、冲四一步成五、活三两步成杀）
    score += (myT.live4 - opT.live4) * SCORE.LIVE4 * 8;
    score += (myT.rush4 - opT.rush4) * SCORE.RUSH4 * 2;
    score += (myT.live3 - opT.live3) * SCORE.LIVE3 * 2;
    // 【2026-08-18 进攻加权·先手节奏】轮到走棋方（me）有成形攻击链时局面更优：
    // 活三/冲四/双活二/眠三都是进攻形态，先手在握应推进攻击而不是平铺防守。
    // 数值远低于 force 级（一步成五/活四/四三在决策层与搜索内 quickTactic 已截断，
    // 不会被此值翻盘），仅用于在"进攻 vs 防守静态价值接近"时把天平推向进攻。
    score += myT.live3 * SCORE.LIVE3;            // +1W / 活三（两步成杀链）
    score += myT.rush4 * (SCORE.RUSH4 >> 1);     // +5W / 冲四（一步成五链）
    score += myT.live2 * SCORE.LIVE2;            // +300 / 活二（攻击种子积累）
    score += myT.sleep3 * (SCORE.SLEEP3 >> 1);   // +500 / 眠三（潜在冲四线）
    return score;
  }

  /** 一步必胜/必防检测：返回致胜点（若有）。 */
  function findForceMove(board, me, maxCand, forbidEnabled) {
    var near = collectNear(board);
    var cands = genCandidates(board, me, near, maxCand || 30, forbidEnabled);
    var meBlackForbid = forbidEnabled && me === BLACK;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var cl = threatLevel(classifyPoint(board, c.x, c.y, me), meBlackForbid);
      if (cl.force) return { x: c.x, y: c.y };
    }
    return null;
  }

  // ─────────────────────────── AlphaZero 网络融合（单一引擎） ───────────────────────────
  // 自学习模型不改变决策管线（威胁层 → VCT → 深度搜索，ego 棋力保底），
  // 而是以"候选池融合"接入：搜索候选 = 启发式候选（前 maxCand-6）+ 网络 policy top-6。
  // 只增不减：网络推荐进入搜索视野，模型进化后逐渐影响选点；网络缺失时行为与原引擎完全一致。

  var netForward = null; // NetForward 实例（js/net_forward.js）

  function setNet(nf) { netForward = nf; }
  function netReady() { return !!(netForward && netForward.loaded); }

  /** 8 平面特征编码（与 ai/game.py encode_state 一致：4 当前方历史 + 4 对手方历史） */
  function encodeNetState(board, history, player) {
    var planes = new Float64Array(8 * SIZE * SIZE);
    var cur = [], opp = [];
    for (var i = 0; i < history.length; i++) {
      var m = history[i];
      if ((m.player === player) || (typeof m.player === 'string' && m.player === (player === BLACK ? 'black' : 'white'))) cur.push(m);
      else opp.push(m);
    }
    var curLast = cur.slice(-4), oppLast = opp.slice(-4);
    for (var c = 0; c < curLast.length; c++) {
      var s = curLast[c];
      planes[c * SIZE * SIZE + s.y * SIZE + s.x] = 1.0;
    }
    for (var o = 0; o < oppLast.length; o++) {
      var t = oppLast[o];
      planes[(4 + o) * SIZE * SIZE + t.y * SIZE + t.x] = 1.0;
    }
    return planes;
  }

  /** 候选池融合：网络 policy top-6（不在启发式候选中的点）替换候选末尾最弱点。
   *  【2026-08-16 门控】只有 policy 概率 ≥ 2×均匀分布 的点才入选——弱模型 policy
   *   接近均匀（无信息），强制替换只会把坏点塞进搜索（棋力下降）；模型进化后
   *   policy 集中，高质量点自然进入候选池。 */
  function fuseNetCandidates(board, me, history, cands, maxCand) {
    if (!netReady() || !history || history.length < 4) return cands;
    var planes;
    try { planes = encodeNetState(board, history, me); } catch (e) { return cands; }
    var r;
    try { r = netForward.forward(planes); } catch (e) { return cands; }
    // 合法点按网络概率降序
    var top = [];
    var legalCount = 0;
    for (var i = 0; i < SIZE * SIZE; i++) {
      var x = i % SIZE, y = (i / SIZE) | 0;
      if (get(board, x, y) !== EMPTY) continue;
      legalCount++;
      top.push({ x: x, y: y, p: r.policy[i] });
    }
    var threshold = 2 / legalCount; // 均匀分布的 2 倍
    top.sort(function (a, b) { return b.p - a.p; });
    var inCands = {};
    for (var j = 0; j < cands.length; j++) inCands[cands[j].x + ',' + cands[j].y] = 1;
    var add = [];
    for (var k = 0; k < top.length && add.length < 6; k++) {
      var t = top[k];
      if (t.p < threshold) break; // 后续概率更低，无信息
      if (!inCands[t.x + ',' + t.y]) { add.push(t); inCands[t.x + ',' + t.y] = 1; }
    }
    if (!add.length) return cands;
    var keep = Math.max(0, maxCand - add.length);
    return cands.slice(0, keep).concat(add.map(function (a) { return { x: a.x, y: a.y, s: 0 }; }));
  }

  /**
   * 预防性防守（VCF/必胜源头拦截）：
   * 对方存在某个候选点 c，若对方落 c 后将立即获得
   *   ① 一步必胜点（活四/五连成型，如黑 H10 → G9 活四）或
   *   ② VCF 必胜链（连续冲四）
   * 我方抢先占据 c，从源头掐断。
   * 高段位专用；开销可控（只对候选点模拟 + 浅搜索）。
   */
  /**
   * 落点无解杀判定：对方在 (p) 落子后，我方是否面临"预防级"威胁（必须提前占 p）。
   * 无解定义（保守版）：
   *   ① 对方出现 ≥2 个一步必胜成型点（双杀），或 ≥1 个活四成型点（黑落 q 即活四，无解）；
   *      单五连成型点（白占即防）不算。
   *   【2026-08-16 回退】曾升级为"占成型点后对方改道仍杀才算无解"的双杀验证——
   *   逻辑更精确，但实战有害：I11 判"可防"后白不再预防，黑 I11 线照杀（棋谱7 白胜→黑胜）。
   *   保守版宁可过度预防，也不放过真源头。
   *   ② 对方能启动连续冲四 VCF 链（p 自身冲四 → 我方强制堵缺口 → 对方再链成杀）。
   */
  function threatAfter(board, me, p, forbidEnabled, dl) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    set(board, p.x, p.y, you); // 模拟对方落 p
    var has = false, forceCnt = 0;
    var near = collectNear(board);
    for (var n = 0; n < near.length && !has; n++) {
      var nx = near[n][0], ny = near[n][1];
      if (youBlackForbid && isForbidMove(board, nx, ny)) continue;
      var cc = classifyPoint(board, nx, ny, you);
      var tl = threatLevel(cc, youBlackForbid);
      if (tl.force) {
        forceCnt++;
        if (cc.live4 > 0 || forceCnt >= 2) has = true; // 活四成型点或双杀
      }
    }
    if (!has) {
      // ② p 自身冲四 → 我方必堵缺口 → 对方是否仍有杀（VCF 链）
      var gaps = rushGapsOf(board, p.x, p.y, you);
      for (var g = 0; g < gaps.length && !has; g++) {
        var gx = gaps[g][0], gy = gaps[g][1];
        set(board, gx, gy, me); // 我方必堵缺口（强制应手）
        has = vcfSearch(board, you, 2, forbidEnabled, dl) !== null;
        set(board, gx, gy, EMPTY);
      }
    }
    set(board, p.x, p.y, EMPTY);
    return has;
  }

  /**
   * 预防性防守（VCF/必胜源头拦截）：
   * 对方存在某个候选点 c，若对方落 c 后将立即获得无解杀（活四/双杀/VCF 链），
   * 且我方占住 c 后对方改走任何点都不再无解杀 → c 为真源头，抢先占据。
   * 高段位专用；开销可控（候选点模拟 + 浅搜索 + 源头二次验证）。
   */
  function preventVcfDecide(board, me, cands, forbidEnabled, dl) {
    var you = opp(me);
    // 视角纪律：预防点模拟的是"对方落子"，必须用 you 视角候选——
    // me 视角候选会漏掉对方的关键进攻点（棋谱8：C12 落黑是跳三，黑视角排前，
    // 白视角排到 30 名外 → 预防层扫不到黑杀链源头 → 返回 null）。
    var youCands = genCandidates(board, you, collectNear(board), 20, forbidEnabled);
    for (var i = 0; i < youCands.length; i++) {
      if (Date.now() > dl) break;
      var c = youCands[i];
      if (get(board, c.x, c.y) !== EMPTY) continue; // 该点已被占（如刚下的防守子），跳过
      if (!threatAfter(board, me, c, forbidEnabled, dl)) continue; // 对方落 c 无无解杀，不需预防
      // 源头验证：我方占住 c 后，对方改落其他候选点是否仍能启动无解杀？
      // 若仍能（如占 K11 后黑仍可走 I11 双活四、占 D11 后黑仍可走 C12），
      // 说明 c 不是真源头，继续找。
      set(board, c.x, c.y, me);
      var still = false;
      // 源头验证范围：前 10 个对方候选（覆盖 K11/C12 类关键改道点）。
      // 全量扫描在 threatAfter 变重后易超预算提前 break → 误判"占后无杀"，
      // 反而选出假源头（棋谱7 曾因此从 I11 退回 K11）。
      var subN = Math.min(10, youCands.length);
      for (var j = 0; j < subN && !still; j++) {
        if (Date.now() > dl) break;
        var c2 = youCands[j];
        if (get(board, c2.x, c2.y) !== EMPTY) continue;
        still = threatAfter(board, me, c2, forbidEnabled, dl);
      }
      set(board, c.x, c.y, EMPTY);
      if (!still) return c;
    }
    return null;
  }

  /**
   * 进攻起点检测（VCF 先手）：我方落 c 后，存在空点 Y 使我方落 Y **直接五连**（win 成型点），
   * 且五连线**包含 c**（c 是起点，制造强制应手抢先手——对方必须先应 Y，否则我五连）。
   * 棋谱11：白落 G6 后 I6 是五连成型点（含 G6），黑被迫应 I6，白连续进攻取胜。
   * 【2026-08-16】只做 win 级：活四成型点（对方可堵成型点，我方后续可能断链）实测
   * 导致九段 0:5 输八段——决策层只出手最强制应手，活四/活三成型交给搜索评估。
   * 线含 c 验证：否则 Y 是独立威胁（my-win 层已处理），与 c 无关
   * （棋谱8：白落 H12 后 J12 五连线不含 H12 是误判，但 I13-H12-G11-F10-E9 线含 H12 ✓）。
   * 开销：cands × near × 方向扫描，预算内 break。
   */
  /**
   * 连续威胁链（VCT）搜索（2026-08-16）：我方"冲四→冲四→活四/五连成型"的
   * 必胜强制链检测。与 vcfSearch（纯连续冲四 VCF）的区别：VCT 允许冲四链后
   * 以活四成型/双冲四/四三收网——对手每一步都被钉死（应冲四缺口），无自由手。
   * 棋谱19 白 22：I6 冲四（黑必应 H6）→ J5 冲四（黑必应 J4）→ K4 活四成型
   * （K4-J5-I6-H7 双口 G8/L3）→ 黑防一口白另一口五连 → 必胜。
   * 此前 vcfStartUsable 只看"先手后一步 force 成型点"（K4 单落只是活三 rank2），
   * 两步链被误判无胜机 → 白 22 错走防守 K8。VCT 补上"冲四到胜利"的计算能力。
   */
  function findRush4Gap(bd, x, y, p) {
    for (var d = 0; d < 4; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var cnt = 1;
      var px = x + dx, py = y + dy;
      while (inB(px, py) && get(bd, px, py) === p) { cnt++; px += dx; py += dy; }
      var rx = px, ry = py;
      px = x - dx; py = y - dy;
      while (inB(px, py) && get(bd, px, py) === p) { cnt++; px -= dx; py -= dy; }
      var lx = px, ly = py;
      if (cnt === 4) {
        var openL = inB(lx, ly) && get(bd, lx, ly) === EMPTY;
        var openR = inB(rx, ry) && get(bd, rx, ry) === EMPTY;
        if (openL && !openR) return { x: lx, y: ly };
        if (openR && !openL) return { x: rx, y: ry };
      }
    }
    return null;
  }
  function vctSearch(board, me, depth, forbidEnabled, dl) {
    if (depth <= 0 || Date.now() > dl) return false;
    var meBlackForbid = forbidEnabled && me === BLACK;
    var near = collectNear(board);
    var moves = [];
    for (var n = 0; n < near.length; n++) {
      if (Date.now() > dl) return false;
      var nx = near[n][0], ny = near[n][1];
      if (get(board, nx, ny) !== EMPTY) continue;
      if (meBlackForbid && isForbidMove(board, nx, ny)) continue;
      set(board, nx, ny, me);
      var c = classifyPoint(board, nx, ny, me);
      if (c.win > 0 || c.live4 > 0 || c.rush4 >= 2 || (c.rush4 >= 1 && c.live3 >= 1)) {
        // 五连/活四/双冲四/四三 = 必胜形态（对手防不住）
        set(board, nx, ny, EMPTY);
        return true;
      }
      if (c.rush4 >= 1) moves.push({ x: nx, y: ny }); // 单冲四 → 强制链候选
      set(board, nx, ny, EMPTY);
    }
    for (var i = 0; i < moves.length; i++) {
      if (Date.now() > dl) return false;
      var m = moves[i];
      set(board, m.x, m.y, me);
      var gap = findRush4Gap(board, m.x, m.y, me);
      // 注意：递归前绝不能恢复 m——递归局面必须保留"我已落 m"（棋谱19 修复：
      // 曾先恢复 m 再让对手应缺口，递归里白 J5 不在盘上，K4 活四链断裂，VCT 误报无路）。
      if (!gap || get(board, gap.x, gap.y) !== EMPTY) { set(board, m.x, m.y, EMPTY); continue; }
      set(board, gap.x, gap.y, opp(me)); // 对手必应缺口（唯一）
      var ok = vctSearch(board, me, depth - 1, forbidEnabled, dl);
      set(board, gap.x, gap.y, EMPTY);   // 恢复对手应手
      set(board, m.x, m.y, EMPTY);       // 恢复我的落子
      if (ok) return true;
    }
    return false;
  }

  function findVcfStarts(board, me, cands, forbidEnabled, dl) {
    var meBlackForbid = forbidEnabled && me === BLACK;
    var near = collectNear(board);
    var hits = [];
    for (var i = 0; i < cands.length && hits.length < 5; i++) {
      if (Date.now() > dl) break;
      var c = cands[i];
      if (get(board, c.x, c.y) !== EMPTY) continue;
      set(board, c.x, c.y, me);
      var has = false;
      for (var n = 0; n < near.length && !has; n++) {
        var nx = near[n][0], ny = near[n][1];
        if (get(board, nx, ny) !== EMPTY) continue;
        if (meBlackForbid && isForbidMove(board, nx, ny)) continue;
        set(board, nx, ny, me);
        var lineHit = false;
        for (var d2 = 0; d2 < 4 && !lineHit; d2++) {
          var dx2 = DIRS[d2][0], dy2 = DIRS[d2][1];
          var cnt2 = 1, onLine = false;
          var px = nx + dx2, py = ny + dy2;
          while (inB(px, py) && get(board, px, py) === me) { cnt2++; if (px === c.x && py === c.y) onLine = true; px += dx2; py += dy2; }
          px = nx - dx2; py = ny - dy2;
          while (inB(px, py) && get(board, px, py) === me) { cnt2++; if (px === c.x && py === c.y) onLine = true; px -= dx2; py -= dy2; }
          if (cnt2 >= 5 && onLine) lineHit = true;
        }
        set(board, nx, ny, EMPTY);
        if (lineHit) has = true;
      }
      set(board, c.x, c.y, EMPTY);
      if (has) hits.push(c);
    }
    return hits;
  }

  /**
   * 先手有效性验证（2026-08-16）：findVcfStart 命中后，检查该先手是否"有效"。
   * 有效定义：我落 atk、对手必应五连成型点 Y 后，我仍能防住对手全部 force 威胁
   * （依次占各 force 成型点后，对手改走其他点均无无解杀）。
   * 反例（虚先手，须拒绝）：棋谱14 白 N4（O4 五连成型逼黑应）后黑 F6/F10/E8
   * 三威胁仍在，白防不完 → N4 是无效进攻；棋谱11 白 G6 同理（黑 I8+G9 双威胁无解）。
   * 正例（有效，保留）：棋谱10 白 J5（J6 五连成型逼黑应）后白 D11 可防黑活四 →
   * 先手赢得回防时间，黑无杀。
   */
  function vcfStartUsable(board, me, atk, forbidEnabled, dl, vctDepth) {
    var you = opp(me);
    var near = collectNear(board);
    var meBlackForbid = forbidEnabled && me === BLACK;
    set(board, atk.x, atk.y, me);
    // 找五连成型点 Y（线含 atk，对手必应）
    var Y = null;
    for (var n = 0; n < near.length && !Y; n++) {
      var nx = near[n][0], ny = near[n][1];
      if (get(board, nx, ny) !== EMPTY) continue;
      if (meBlackForbid && isForbidMove(board, nx, ny)) continue;
      set(board, nx, ny, me);
      var lineHit = false;
      for (var d2 = 0; d2 < 4 && !lineHit; d2++) {
        var dx2 = DIRS[d2][0], dy2 = DIRS[d2][1];
        var cnt2 = 1, onLine = false;
        var px = nx + dx2, py = ny + dy2;
        while (inB(px, py) && get(board, px, py) === me) { cnt2++; if (px === atk.x && py === atk.y) onLine = true; px += dx2; py += dy2; }
        px = nx - dx2; py = ny - dy2;
        while (inB(px, py) && get(board, px, py) === me) { cnt2++; if (px === atk.x && py === atk.y) onLine = true; px -= dx2; py -= dy2; }
        if (cnt2 >= 5 && onLine) lineHit = true;
      }
      set(board, nx, ny, EMPTY);
      if (lineHit) Y = { x: nx, y: ny };
    }
    if (!Y) { set(board, atk.x, atk.y, EMPTY); return false; }
    set(board, Y.x, Y.y, you); // 对手必应 Y（强制应手）
    // 【2026-08-16 VCT 胜机检查】黑应 Y 后，我先查自己是否有连续强制链
    // （冲四→…→活四/五连成型）——有则必胜，无需防黑杀点：黑全程被钉死
    // （棋谱19 白 22 I6：黑 H6 → 白 J5 冲四 → 黑 J4 → 白 K4 活四 → 白胜，
    // 黑 K8/N7 杀点永远没机会落子）。VCT 失败才走"防住黑 force"的旧验证。
    if (vctSearch(board, me, vctDepth || 4, forbidEnabled, dl)) {
      set(board, Y.x, Y.y, EMPTY);
      set(board, atk.x, atk.y, EMPTY);
      return true;
    }
    // 对手 force 成型点
    var youCands = genCandidates(board, you, collectNear(board), 16, forbidEnabled);
    var opPts = [];
    for (var i = 0; i < youCands.length; i++) {
      var cc = youCands[i];
      if (get(board, cc.x, cc.y) !== EMPTY) continue;
      var tl = threatLevel(classifyPoint(board, cc.x, cc.y, you), forbidEnabled && you === BLACK);
      if (tl.force) opPts.push(cc);
    }
    var usable = true;
    for (var j = 0; j < opPts.length && usable; j++) {
      if (Date.now() > dl) { usable = false; break; }
      var pt = opPts[j];
      set(board, pt.x, pt.y, me); // 我占该成型点
      // 黑是否仍有一步 force 成型点（活四/双冲四/四三/双活三/五连成型）？
      // 注：不用 threatAfter（把"黑落 c2 制造活四成型点"也算无解，过保守——
      // 白可下一手继续占该成型点，如棋谱10 白 D11 后黑无 force、J5 应判有效）。
      var subCands2 = genCandidates(board, you, collectNear(board), 16, forbidEnabled);
      var stillForce = false;
      for (var k = 0; k < subCands2.length && !stillForce; k++) {
        var c3 = subCands2[k];
        if (get(board, c3.x, c3.y) !== EMPTY) continue;
        var tl3 = threatLevel(classifyPoint(board, c3.x, c3.y, you), forbidEnabled && you === BLACK);
        if (tl3.force) stillForce = true;
      }
      if (!stillForce) {
        // 黑两步 VCF 链（连续冲四收网）
        stillForce = vcfSearch(board, you, 3, forbidEnabled, dl) !== null;
      }
      set(board, pt.x, pt.y, EMPTY);
      if (stillForce) usable = false;
    }
    // 【2026-08-16 胜机检查】黑应 Y 后，我必须有下一步杀（force 成型点），
    // 否则先手只是"以冲四换防守"，没有胜机——拒绝（棋谱15 白 E6 冲四后只能
    // 回防 K5、白 J7 冲四后死四，均属无胜机冲四；棋谱10 白 J5 同理改走直接防）。
    if (usable) {
      var myCands = genCandidates(board, me, collectNear(board), 16, forbidEnabled);
      usable = false;
      for (var mi = 0; mi < myCands.length && !usable; mi++) {
        if (Date.now() > dl) break;
        var mcc = myCands[mi];
        if (get(board, mcc.x, mcc.y) !== EMPTY) continue;
        var mtl = threatLevel(classifyPoint(board, mcc.x, mcc.y, me), meBlackForbid);
        if (mtl.force) usable = true;
      }
    }
    set(board, Y.x, Y.y, EMPTY);
    set(board, atk.x, atk.y, EMPTY);
    return usable;
  }

  /**
   * 两步威胁检测（2026-08-16）：对方落 c 后（c 本身非 force），对方存在 q：
   * 落 q 后形成四三/活四/双冲四（force rank>=3）→ 两步杀。
   * 我抢先占成型点 q（优先）或源头 c，占后对方改走其他点仍无杀才算防住。
   * 背景：这类"预埋型"威胁静态无威胁（如黑 G12 跳二），启发分低、搜索难发现，
   * 但配合已存在的跳二/活二即成四三（棋谱17 黑 G12→F11）。
   */
  function findOpTwoStep(board, me, forbidEnabled, dl) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    // 候选必须全近点扫描：预埋点静态无威胁（黑 G12 跳二启发分最低档），
    // 按启发分取前 N 个会被挤出候选（棋谱17 黑 G12→F11 四三曾检测不到）。
    // 近点 ~80 × q 扫描 8：classify 极快，250ms 预算内可完成。
    var near = collectNear(board);
    var threats = [];
    for (var i = 0; i < near.length; i++) {
      if (Date.now() > dl) break;
      var c = { x: near[i][0], y: near[i][1] };
      if (get(board, c.x, c.y) !== EMPTY) continue;
      set(board, c.x, c.y, you); // 对方落 c
      // 【2026-08-16 强度过滤】只预防"双威胁"（黑落 c 后黑有 ≥2 个 force 成型点，
      // 白一手防不完，如棋谱17 黑 G12 → G11 五连成型 + F11 四三成型）。
      // 单 force 成型点（如棋谱18 黑 I5 → H4 活四成型）白事后占成型点即可防，
      // 提前大跳预防是浪费一手（曾导致白 12 手 H4 大跳）。
      var qPts = [];
      var c2 = genCandidates(board, you, collectNear(board), 8, forbidEnabled);
      for (var j = 0; j < c2.length; j++) {
        var q = c2[j];
        if (get(board, q.x, q.y) !== EMPTY) continue;
        if (youBlackForbid && isForbidMove(board, q.x, q.y)) continue;
        var tl = threatLevel(classifyPoint(board, q.x, q.y, you), youBlackForbid);
        if (tl.force && tl.forceRank >= 3) qPts.push(q); // 落 q 后四三/活四/双冲四/五连
      }
      // 【2026-08-16 强度过滤】只预防"无解级"双威胁：qPts 中存在非活四型 force 点
      // （五连成型/双冲四/四三——白无法一手防完，如棋谱17 黑 G12 → G11 五连 + F11 四三）。
      // 纯活四成型点（黑落 q 后四连双端开）白占 q 即可防（另一个变冲四可堵）——
      // 黑 I5 → H4/L8 双活四成型属"可防级"，提前大跳预防是浪费一手（棋谱18 白 12 曾大跳 H4）。
      // 注意：检测必须在恢复 c 之前做（q 的 force 判定依赖 c 支撑，如 F11 四三需 G12 已落）。
      if (qPts.length >= 2 && qPts.some(function (qp) {
        var qc = classifyPoint(board, qp.x, qp.y, you);
        return qc.win > 0 || qc.rush4 >= 2 || (qc.rush4 >= 1 && qc.live3 >= 1);
      })) {
        threats.push({ c: c, qPts: qPts });
      }
      set(board, c.x, c.y, EMPTY);
    }
    // 验证：遍历"全部 force 成型点 q + 源头 c"，占后对方 force 成型点能被逐个占完
    // 且无 VCF 链才算防住（棋谱17：G12 的 qPts=[G11(五连), F11(四三)]，占 G11 失败
    // （黑 F11 四三仍在）、占 F11 成功 → 正解 F11）。
    // 注：不用 threatAfter 验证（把"单活四成型点"也判无解，过保守——白占 F11 后黑 D10 制造
    // F10 活四成型点，白下一手可占 F10 防住，曾误拒 F11）。
    for (var k = 0; k < threats.length; k++) {
      if (Date.now() > dl) break;
      var t = threats[k];
      var order = t.qPts.concat([t.c]);
      for (var ci = 0; ci < order.length; ci++) {
        var p = order[ci];
        if (get(board, p.x, p.y) !== EMPTY) continue;
        set(board, p.x, p.y, me);
        var ok = true;
        // 对方 force 成型点（黑落 q 即活四/双冲四/四三/双活三/五连）
        var opNear = collectNear(board);
        var opPts = [];
        for (var oi = 0; oi < opNear.length && Date.now() <= dl; oi++) {
          var opX = opNear[oi][0], opY = opNear[oi][1];
          if (get(board, opX, opY) !== EMPTY) continue;
          if (youBlackForbid && isForbidMove(board, opX, opY)) continue;
          var otl = threatLevel(classifyPoint(board, opX, opY, you), youBlackForbid);
          if (otl.force && otl.forceRank >= 3) opPts.push({ x: opX, y: opY });
        }
        for (var oi2 = 0; oi2 < opPts.length && ok; oi2++) {
          if (Date.now() > dl) { ok = false; break; }
          var opPt = opPts[oi2];
          set(board, opPt.x, opPt.y, me); // 白逐个占 force 成型点
          var still2 = false;
          var subNear = collectNear(board);
          for (var sj = 0; sj < subNear.length && !still2; sj++) {
            var sx = subNear[sj][0], sy = subNear[sj][1];
            if (get(board, sx, sy) !== EMPTY) continue;
            if (youBlackForbid && isForbidMove(board, sx, sy)) continue;
            var stl = threatLevel(classifyPoint(board, sx, sy, you), youBlackForbid);
            if (stl.force) still2 = true;
          }
          if (!still2) still2 = vcfSearch(board, you, 3, forbidEnabled, dl) !== null;
          set(board, opPt.x, opPt.y, EMPTY);
          if (still2) ok = false;
        }
        set(board, p.x, p.y, EMPTY);
        if (ok) return p;
      }
    }
    return null;
  }

  /**
   * 多成型点万能防守：对方有 ≥2 个同级 force 成型点（如双四三 L7/M9，棋谱23），
   * 白一手只能占一个成型点 → 必漏另一个。搜索一个"万能点"：白落 p 后，
   * 对方全部原 force 成型点降级为可防级（非 五连/活四/双冲四 成型），
   * 即单点同时废掉所有成型威胁（如白 J9 废 M9 四三的活三线、L7 降级可防）。
   * 找不到返回 null（fallback 威胁决策层防最高 rank 成型点）。
   */
  /**
   * 多成型点万能防守：对方有 ≥2 个同级 force 成型点（如双四三 L7/M9，棋谱23），
   * 白一手只能占一个成型点 → 必漏另一个。搜索一个"万能点"：白落 p 后，
   * 对每个原成型点 q：黑落 q 后，白仍存在一步 r 使黑方无 rank>=3 force 成型点
   * （深度 1 防守验证）。这样 p 必须真正削弱所有 q 的威胁链。
   * 棋谱23 白 18 = J9：废 M9 四三的活三线（K9-L9-M9 单口）+ L7 线被白 J7 的
   * J 列四连反杀牵制（黑必应 J11），白 22 L6 再防黑活四——唯一活路。
   * D7 类无关点不通过：黑 M9 四三后白无论落哪，黑仍保有 N10 五连/L7 四三。
   * 找不到返回 null（fallback 威胁决策层防最高 rank 成型点）。
   */
  /**
   * 强制防守模拟：① 白每步先占黑最高 rank force 成型点（阻止黑落点）；
   * ② 黑走时若白有 win 成型点（白落即五连，围魏救赵反杀——棋谱23 白 20 J7 后
   * 白 J11 五连成型，黑 21 被迫防 J11 而非走 L6 活四），黑必须先防白；
   * ③ 否则黑走白未防住的最高 force 成型点，黑落点即五连/活四 → 白败。
   * maxSteps 步内黑杀不出 → 可防。棋谱23 白 18 J9 通过（J9 补 J 列缺口，
   * J7 落白后 J 列连续四连 + J11 反杀）；D7 类点不通过（J 列跳形无反杀，
   * 黑 L7→L6 活四链杀）。输入 board 为副本（自由落子不恢复）。
   */
  function defendSim(board, me, forbidEnabled, dl, maxSteps) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    var meBlackForbid = forbidEnabled && me === BLACK;
    for (var s = 0; s < (maxSteps || 6); s++) {
      // 【2026-08-16】超时必须拒绝（return false）而非放行：放行会让预算耗尽后
      // 排在后面的候选全部"超时通过"→ findMultiForceDefense 返回垃圾万能点
      //（棋谱25 黑21 超时误判 H11 可防，实际白 L6 四三后黑防不住）。拒绝 →
      // findMultiForceDefense 返回 null → fallback 威胁决策层防最高 rank 成型点。
      if (Date.now() > dl) return false;
      // ① 黑占白最高 force 成型点（白落即 rank>=3 force）
      // 【2026-08-16】全近点扫描（不依赖 genCandidates 前 16 排序）——候选排序
      // 可能漏掉 force 点（棋谱25：黑 H11+白 L6 局面 K7 五连成型 s=201 万本应第一，
      // 但特定局面候选截断后①步漏检 → H11 被误判可防）。force 点全量检测，
      // 超时由 dl 拒绝兜底。
      var rs = [];
      var nearAll = collectNear(board);
      for (var j = 0; j < nearAll.length; j++) {
        var r2 = nearAll[j];
        var rx2 = r2[0], ry2 = r2[1];
        if (get(board, rx2, ry2) !== EMPTY) continue;
        var ol2 = threatLevel(classifyPoint(board, rx2, ry2, you), youBlackForbid);
        if (ol2.force && ol2.forceRank >= 3) rs.push({ x: rx2, y: ry2, rank: ol2.forceRank });
      }
      if (!rs.length) return true;
      rs.sort(function (a, b) { return b.rank - a.rank; });
      set(board, rs[0].x, rs[0].y, me);
      // ② 白 win 成型点（白落即五连）→ 黑必须先防（围魏救赵牵制）
      var wWin = null;
      var ycW = genCandidates(board, me, collectNear(board), 16, forbidEnabled);
      for (var w = 0; w < ycW.length && !wWin; w++) {
        var wc = ycW[w];
        if (get(board, wc.x, wc.y) !== EMPTY) continue;
        if (meBlackForbid && isForbidMove(board, wc.x, wc.y)) continue;
        var ml = classifyPoint(board, wc.x, wc.y, me);
        if (ml.win > 0) wWin = wc;
      }
      if (wWin) { set(board, wWin.x, wWin.y, you); continue; } // 黑防白五连，回 ① 白再占
      // ③ 白走黑未防住的最高 force 成型点（全近点扫描，同上）
      var qs = [];
      var nearAll2 = collectNear(board);
      for (var i = 0; i < nearAll2.length; i++) {
        var q = nearAll2[i];
        var qx = q[0], qy = q[1];
        if (get(board, qx, qy) !== EMPTY) continue;
        var ol = threatLevel(classifyPoint(board, qx, qy, you), youBlackForbid);
        if (ol.force && ol.forceRank >= 3) qs.push({ x: qx, y: qy, rank: ol.forceRank });
      }
      if (!qs.length) return true;
      qs.sort(function (a, b) { return b.rank - a.rank; });
      var q = qs[0];
      // 白落 q 即五连/活四 → 黑已无法占回（活四双口黑只堵一口）→ 败
      var cq = classifyPoint(board, q.x, q.y, you);
      if (cq.win > 0 || cq.live4 > 0) return false;
      set(board, q.x, q.y, you);
    }
    return true;
  }

  /**
   * 多成型点万能防守：对方有 ≥2 个同级 force 成型点（如双四三 L7/M9，棋谱23），
   * 白一手只能占一个成型点 → 必漏另一个。搜索"万能点"：白落 p 后，对每个原成型点
   * q：黑落 q 后，强制防守模拟 6 步内黑杀不出（白可防）→ p 通过。
   * 棋谱23 白 18 = J9（废 M9 活三线 + 白竖活三反制）；D7 类无关点不通过。
   * 找不到返回 null（fallback 防最高 rank 成型点）。
   */
  function findMultiForceDefense(board, me, opPts, forbidEnabled, dl) {
    var you = opp(me);
    var near = collectNear(board);
    // p 候选排序：① 白落 p 后白自身有威胁（J9 落白竖活三 → 前排，围魏救赵反杀点
    // 命中快、价值高）② 成型点本身（直接占掉一个）③ 其余。预算内尽快命中——
    // 全遍历耗时会挤占搜索（350ms 曾致九段黑降智输八段，2026-08-16 实测）。
    var pCands = [];
    var meBlackForbid = forbidEnabled && me === BLACK;
    for (var i = 0; i < near.length; i++) {
      var p = near[i];
      var px = p[0], py = p[1];
      if (get(board, px, py) !== EMPTY) continue;
      if (meBlackForbid && isForbidMove(board, px, py)) continue;
      var mc = classifyPoint(board, px, py, me);
      var atk = (mc.win > 0 || mc.rush4 >= 1 || mc.live3 >= 1) ? 1 : 0;
      var isOp = 0;
      for (var oi = 0; oi < opPts.length; oi++) if (opPts[oi].x === px && opPts[oi].y === py) { isOp = 1; break; }
      pCands.push({ x: px, y: py, atk: atk, isOp: isOp });
    }
    pCands.sort(function (a, b) {
      var d = (b.atk - a.atk) * 2 + (b.isOp - a.isOp);
      if (d !== 0) return d;
      return POS_WEIGHT[b.y * SIZE + b.x] - POS_WEIGHT[a.y * SIZE + a.x];
    });
    for (var k = 0; k < pCands.length; k++) {
      if (Date.now() > dl) break;
      var px = pCands[k].x, py = pCands[k].y;
      set(board, px, py, me);
      var allDef = true;
      for (var j = 0; j < opPts.length && allDef; j++) {
        var q = opPts[j];
        if (get(board, q.x, q.y) !== EMPTY) continue; // 白已占该成型点 → 已防
        set(board, q.x, q.y, you);
        // 黑落 q 即五连/活四 → 黑已成型，白无法占回（活四双口白只堵一口）→ p 不合格。
        // 【2026-08-16 修复】classifyPoint 内部会 set(q)+计算+set(q,EMPTY) 恢复——
        // q 是预落子必须保留，预检后会清掉 q → defendSim 拿到"无 q"棋盘 →
        // 威胁凭空消失误判可防（棋谱25 黑21 H11：q=L6 被清 → 白 L6 四三未参与
        // 模拟 → H11 误通过）。预检后重新落回 q。
        var cq = classifyPoint(board, q.x, q.y, you);
        if (cq.win > 0 || cq.live4 > 0) { set(board, q.x, q.y, EMPTY); allDef = false; break; }
        set(board, q.x, q.y, you); // 重新落回（classifyPoint 恢复时清掉了）
        var sim = board.slice ? board.slice() : board;
        if (!defendSim(sim, me, forbidEnabled, dl, 6)) allDef = false;
        set(board, q.x, q.y, EMPTY);
      }
      set(board, px, py, EMPTY);
      if (allDef) return { x: px, y: py };
    }
    return null;
  }

  /**
   * 【2026-08-18 进攻优先】我方是否存在"成型攻击先手"：
   * 落子即形成 force rank>=2 的攻击形态（双活三/四三/双冲四/活四/五连成型点）。
   * 双活三（rank2）虽由搜索权衡而非决策层直出，但它是真正的先手压制——
   * 对方被迫应我活三，无自由手去走预埋杀。用于预防层守卫：
   * 我方有成型攻击先手时，先手节奏快于"预埋两步杀"，预防层不得抢先顶掉进攻。
   * 注意：对方若有一步杀/活四/四三（force rank>=3），威胁决策层已先于本处拦截，
   * 必防优先级不受影响；对方 VCF 连续冲四链也在本处之前处理（oppVcf 块）。
   */
  function hasWinningInitiative(board, me, forbidEnabled) {
    var meBlackForbid = forbidEnabled && me === BLACK;
    var near = collectNear(board);
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      if (meBlackForbid && isForbidMove(board, x, y)) continue; // 黑禁手点不构成先手
      var tl = threatLevel(classifyPoint(board, x, y, me), meBlackForbid);
      if (tl.force && tl.forceRank >= 2) return true;
    }
    return false;
  }

  /**
   * 【2026-08-18 破平守卫】对方是否存在"即时威胁成型点"（force rank>=3）：
   * 一步成五点（win）、活四成型、四三、双冲四。存在时防守优先级必须压过
   * 任何进攻破平——根节点进攻活性破平前必须先查本函数（顺序不能反）。
   */
  function hasImmediateOppThreat(board, me, forbidEnabled) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    var near = collectNear(board);
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      var ol = threatLevel(classifyPoint(board, x, y, you), youBlackForbid);
      if (ol.force && ol.forceRank >= 3) return true;
    }
    return false;
  }

  /**
   * 连续活三的另一端：p=(x,y) 是对方活四成型点（对方落 p 成连续四连活四）。
   * 返回该连续活三的远端点（另一端堵点）；若 p 不是连续四连端点则返回 null。
   * 例：横活三 (3,7)(4,7)(5,7)，p=(2,7) → 另一端 (6,7)。
   */
  function live3FarEnd(board, x, y, you) {
    set(board, x, y, you);
    var found = null;
    for (var d = 0; d < 4 && !found; d++) {
      var dx = DIRS[d][0], dy = DIRS[d][1];
      var cntR = 0, cntL = 0;
      var nx = x + dx, ny = y + dy;
      while (inB(nx, ny) && get(board, nx, ny) === you) { cntR++; nx += dx; ny += dy; }
      var openR = inB(nx, ny) && get(board, nx, ny) === EMPTY;
      nx = x - dx; ny = y - dy;
      while (inB(nx, ny) && get(board, nx, ny) === you) { cntL++; nx -= dx; ny -= dy; }
      var openL = inB(nx, ny) && get(board, nx, ny) === EMPTY;
      // 连续四连活四：cntR+cntL+1 === 4 且两端开放；p 在端点（cntR===3 或 cntL===3）
      if (cntR + cntL + 1 === 4 && openR && openL) {
        if (cntR === 3) found = { x: x + 4 * dx, y: y + 4 * dy };
        else if (cntL === 3) found = { x: x - 4 * dx, y: y - 4 * dy };
      }
    }
    set(board, x, y, EMPTY);
    return found;
  }

  /**
   * 【2026-08-21 威胁竞速守卫】对方存在单活三（或更强）威胁，且我方没有
   * 活三+（活三已在盘/一步活四/一步冲四/一步成五）先手时，必须强制堵活三——
   * 不进入搜索/破平。
   * 竞速规则：我方有活三+先手（活三已在盘 → 一步活四 → 五连）时，先手节奏
   * 快于对方活三（对方活三 → 活四 → 五连），保持进攻；否则对方先到，必须堵。
   * 注意：能"一步成活三"不算活三+先手——那需要 3 手才成五，慢于对方已成形
   * 活三的 2 手杀（棋谱 2026-08-21：黑 21 本可落 (6,7) 一步成己方活三，但
   * 白 22 活四 → 白 24 五连，进攻节奏输给防守）。
   * 堵点选择：对方活三两端都收集（活四成型端 + 连续活三远端点），优先
   * "堵的同时提升己方威胁"的点（成五/活四/冲四/活三 > 活二 > 眠三）；
   * 对方多活三时按多成型点裁决（堵点同时废多个活三者优先）。
   * 禁手兼容：黑棋堵点若为禁手（双活三/双冲四）则跳过，选另一堵点。
   * 返回堵点 {x,y} 或 null（无需强制防守）。
   */
  function threatRaceGuard(board, me, forbidEnabled) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    var meBlackForbid = forbidEnabled && me === BLACK;
    var near = collectNear(board);
    // ① 我方先手检查：存在空点 p，我落 p 即成五/活四/冲四（活三已在盘或一步成型）
    //    → 我方先手更快，保持进攻，守卫不触发。
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      if (get(board, x, y) !== EMPTY) continue;
      if (meBlackForbid && isForbidMove(board, x, y)) continue;
      var mc = classifyPoint(board, x, y, me);
      if (mc.win > 0 || mc.live4 > 0 || mc.rush4 > 0) return null;
    }
    // ② 对方威胁检查：收集对方活三两端堵点 + 更强威胁（成五点/活四在盘）堵点。
    //    - 成五点：对方落 p 即五连（冲四单口/活四双口）——比活三更急，必须堵
    //    - 活四成型端：对方落 p 即活四（oc.live4 > 0）
    //    - 连续活三远端点：对每个活四成型端 p，找其所在连续活三的另一端
    var blockPts = [];
    var seen = {};
    function addBlock(bx, by, live4, win) {
      var k = bx + ',' + by;
      if (seen[k]) return;
      seen[k] = 1;
      blockPts.push({ x: bx, y: by, live4: live4, win: !!win });
    }
    for (var j = 0; j < near.length; j++) {
      var bx = near[j][0], by = near[j][1];
      if (get(board, bx, by) !== EMPTY) continue;
      if (youBlackForbid && isForbidMove(board, bx, by)) continue;
      var oc = classifyPoint(board, bx, by, you);
      if (oc.win > 0) {
        // 对方落此点即五连：活四双口/冲四单口/成五点。单口由 threatDecide op-win
        // 已拦截（守卫不运行）；此处覆盖"双口活四=必败局但无抢攻点"的确定性防守，
        // 避免搜索在必堵场景下选点不稳定（2026-08-21 实测同局面有时 (6,7) 有时 (2,6)）。
        addBlock(bx, by, 0, true);
        continue;
      }
      if (oc.live4 > 0) {
        // 【2026-08-21 修复·跳三不触发守卫】只有"连续活三"的活四成型端才强制堵：
        // live3FarEnd 返回非 null 说明该点是连续活三的端点（真活三——堵一头仍可从
        // 另一头活四，必须强制防）。跳三（X.X.X 隔空）补 gap 也成连续活四
        // （oc.live4>0），但 live3FarEnd 返回 null——跳三只有一个补 gap 点、对手堵
        // gap 即废，威胁远弱于连续活三（evaluateBoard 2026-08-16 跳三降级同哲学），
        // 交给搜索权衡，守卫不强制堵。实测旧白爱撒跳形，黑 62% 手数在堵跳三。
        var other = live3FarEnd(board, bx, by, you);
        if (other) {
          addBlock(bx, by, oc.live4);
          addBlock(other.x, other.y, 0);
        }
      }
    }
    if (blockPts.length === 0) return null; // 对方无活三/成五点威胁
    // ③ 选堵点：优先"堵的同时提升己方威胁"；多活三堵点（对方落此点成多个活四）优先；
    //    成五点（对方下一步即五连）绝对优先于活三堵点。
    var best = null, bestScore = -Infinity;
    for (var k = 0; k < blockPts.length; k++) {
      var p = blockPts[k];
      if (meBlackForbid && isForbidMove(board, p.x, p.y)) continue; // 禁手堵点不可落
      var mc2 = classifyPoint(board, p.x, p.y, me);
      var s = 0;
      if (p.win) s += 2000000; // 对方落此点即五连：比活三堵点更急（活四双口/冲四单口）
      if (mc2.win > 0) s += 1000000;
      else if (mc2.live4 > 0) s += 500000;
      else if (mc2.rush4 > 0) s += 200000;
      else if (mc2.live3 > 0) s += 100000;
      else if (mc2.live2 > 0) s += 10000;
      else if (mc2.sleep3 > 0) s += 5000;
      s += p.live4 * 50000; // 堵点同时废多个活三（对方落此点成多个活四）优先
      s += POS_WEIGHT[p.y * SIZE + p.x] * 10;
      if (s > bestScore) { bestScore = s; best = p; }
    }
    return best || blockPts[0];
  }

  /**
   * 【2026-08-18 根节点进攻活性破平】搜索分数几乎相等（启发分差在 epsilon 内）的
   * 候选里，优先选"落子后提升己方威胁等级"的点（活三/冲四/活四/双活二等攻击形态）。
   * 前提守卫：调用方必须先确认 hasImmediateOppThreat===false（对方无即时威胁），
   * 且不改变一步成五（myWin 由威胁决策层直接返回，搜索也以 WIN 级截断）。
   * 保守实现：只在前几名启发接近的候选中挑选，且攻击活性以威胁计数线性累加。
   */
  function pickActiveTieBreak(board, me, cands, bestMove, forbidEnabled) {
    var EPS = 300000; // 启发分差在此范围内视为"接近最优"
    var refS = bestMove ? bestMove.s : cands[0].s;
    var meBlackForbid = forbidEnabled && me === BLACK;
    var best = bestMove || cands[0], bestAtk = -Infinity;
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var ds = c.s - refS;
      if (ds > EPS) continue;  // 启发显著高于搜索最优（罕见），保守跳过
      if (-ds > EPS) break;    // cands 按 s 降序，再往后更差
      var ml = classifyPoint(board, c.x, c.y, me);
      var tl = threatLevel(ml, meBlackForbid);
      var atk = 0;
      if (tl.win) atk += 2000000;
      if (tl.force) atk += 1000000;
      atk += ml.live4 * 600000 + ml.rush4 * 300000 + ml.live3 * 150000 + ml.live2 * 30000;
      if (atk > bestAtk) { bestAtk = atk; best = c; }
    }
    return best;
  }

  /**
   * 威胁决策层（搜索前调用）：只处理确定性的 必胜 / 必防（force 级）。
   * 细分五连与必胜组合：对方五连 > 对方必胜组合，避免"堵活四却不堵五连"的低级失误。
   * 活三/冲四等"强威胁"交给搜索权衡攻防，避免贪心决策架空搜索。
   * 返回 null 表示需要进入搜索。
   */
  function threatDecide(board, me, cands, forbidEnabled) {
    var you = opp(me);
    var meBlackForbid = forbidEnabled && me === BLACK;
    var youBlackForbid = forbidEnabled && you === BLACK;
    var myWin = null, myForce = null, myForceRank = 0;
    var opWinPts = [], opForce = null, opForceRank = 0;
    var opForcePts = [];
    // 我方落点：用 me 视角候选（cands 由调用方按 me 的启发分排序）
    for (var i = 0; i < cands.length; i++) {
      var c = cands[i];
      var ml = threatLevel(classifyPoint(board, c.x, c.y, me), meBlackForbid);
      if (ml.win && !myWin) myWin = c;
      // 【2026-08-16】双活三（rank2）不再由决策层直出：活三不是强制威胁，
      // 对手可用冲四链先手压制（棋谱16：白 H11 双活三被黑 F9→F11→F8 链晾死）。
      // 只直出 rank>=3 的必胜组合（活四/双冲四/四三），双活三交给搜索权衡。
      else if (ml.force && ml.forceRank >= 3 && (!myForce || ml.forceRank > myForceRank)) { myForce = c; myForceRank = ml.forceRank; }
    }
    // 对方落点：必须用 you 视角候选——me 视角候选会漏掉对方的关键进攻点
    //（棋谱8：C12 落黑是跳三，黑视角排前，白视角排到 30 名外 → 漏防黑杀链源头）
    var near = collectNear(board);
    var youCands = genCandidates(board, you, near, 24, forbidEnabled);
    for (var j = 0; j < youCands.length; j++) {
      var c2 = youCands[j];
      var ol = threatLevel(classifyPoint(board, c2.x, c2.y, you), youBlackForbid);
      if (ol.win) {
        // 收集对方全部成五点：单点=对方冲四单口；多点=对方活四双口/双冲四真双杀。
        // 若我（黑）落该点本身是禁手则无法堵，跳过。
        if (meBlackForbid && isForbidMove(board, c2.x, c2.y)) continue;
        opWinPts.push(c2);
        continue;
      }
      // 同上：对方双活三成型（rank2）不视为必防，先手链可压制（棋谱16 黑 F9 线）
      if (ol.force && ol.forceRank >= 3) {
        if (!opForce || ol.forceRank > opForceRank) { opForce = c2; opForceRank = ol.forceRank; }
        opForcePts.push({ x: c2.x, y: c2.y, rank: ol.forceRank });
      }
    }
    // 优先级：我五连 > 对方成五点（必防，不许送杀）> 我方活四/四三（先手杀）> 对方必胜组合。
    // 【2026-08-18 不许送杀修复】opWin（对方落子即五连）必须优先于 myForce（我方活四/四三）：
    //  - 单个成五点（对方冲四单口）：必须堵——此时若去走自己的活四，对方下一手直接五连
    //    获胜，而我方活四需两步才成五，速度慢于对方一步成五 → 送杀。
    //  - 多个成五点（活四双口/双冲四真双杀）：一手堵不完=已败势，堵与不堵都输；
    //    退回 myForce 抢攻兜底（2026-08-16"白 J8 活四放弃防守被反杀"的教训：必败局
    //    别再白送防守，宁可保持进攻）。
    // myWin（我落子立即五连）仍最优先——那是"我这一步就赢"。
    if (myWin) return { move: myWin, kind: 'my-win' };
    if (opWinPts.length === 1) return { move: opWinPts[0], kind: 'op-win' };
    if (myForce) return { move: myForce, kind: 'my-force' };
    if (opForce) {
      // 【2026-08-16】多成型点裁决：对方 ≥2 个 force 成型点（双四三/四三+活四等）时，
      // 先搜"一个点废全部"的万能防守点（棋谱23：黑 L7/M9 双四三，白 18 仅 J9 能活）；
      // 找不到（真双杀，如棋谱22 黑19 M9 后 N10/N9）才退回防最高 rank 成型点。
      if (opForcePts.length >= 2) {
        var multi = findMultiForceDefense(board, me, opForcePts, forbidEnabled, Date.now() + 250);
        if (multi) return { move: multi, kind: 'op-force-multi' };
      }
      return { move: opForce, kind: 'op-force' };
    }
    return null;
  }

  /**
   * 收集对方所有必胜成型点（force 级，供多威胁裁决）。
   * 返回按 forceRank 降序排列的点数组。
   * 内部用 you 视角候选（同 threatDecide 的视角纪律）。
   */
  function collectOpForce(board, me, cands, forbidEnabled, maxCount) {
    var you = opp(me);
    var youBlackForbid = forbidEnabled && you === BLACK;
    var near = collectNear(board);
    var youCands = genCandidates(board, you, near, maxCount || 8, forbidEnabled);
    var pts = [];
    for (var i = 0; i < youCands.length; i++) {
      var c = youCands[i];
      if (get(board, c.x, c.y) !== EMPTY) continue;
      var ol = threatLevel(classifyPoint(board, c.x, c.y, you), youBlackForbid);
      if (ol.force) pts.push({ x: c.x, y: c.y, rank: ol.forceRank });
    }
    pts.sort(function (a, b) { return b.rank - a.rank; });
    return pts;
  }

  /** 搜索内一步必胜/必防截断（含禁手过滤）。直接遍历近点，零排序开销。 */
  function quickTactic(board, me, forbidEnabled) {
    var near = collectNear(board);
    var meBlackForbid = forbidEnabled && me === BLACK;
    for (var i = 0; i < near.length; i++) {
      var x = near[i][0], y = near[i][1];
      if (meBlackForbid && isForbidMove(board, x, y)) continue;
      var cl = threatLevel(classifyPoint(board, x, y, me), meBlackForbid);
      if (cl.force) return { x: x, y: y };
    }
    return null;
  }

  /**
   * negamax + α-β + killer move + 历史表（v3）。
   * 每层先做一步必胜/必防截断，显著压缩杀棋搜索树。
   */
  function negamax(board, me, depth, alpha, beta, deadline, ply, killers, history, forbidEnabled, tt) {
    if (depth <= 0 || Date.now() > deadline) return evaluateBoard(board, me);

    // 威胁截断只在浅层做（depth <= 2）：一步必胜 → 高分（越快越高）；对方一步必胜 → 低分
    // 深层靠评估，避免每层 collectNear 拖慢搜索
    if (depth <= 2) {
      var t = quickTactic(board, me, forbidEnabled);
      if (t) return SCORE.WIN - ply;
      var t2 = quickTactic(board, opp(me), forbidEnabled);
      if (t2) return -(SCORE.WIN - ply);
    }

    // ── 置换表：已搜过的局面直接复用 ──
    var h = 0;
    if (tt) {
      h = zobristHash(board);
      var ent = tt.get(h);
      if (ent && ent.depth >= depth) {
        if (ent.flag === 1) return ent.v;            // 精确值
        if (ent.flag === 2 && ent.v <= alpha) return alpha; // 上界
        if (ent.flag === 3 && ent.v >= beta) return beta;   // 下界
      }
    }

    var near = collectNear(board);
    if (near.length === 0) return 0;
    var cands = genCandidates(board, me, near, 14, forbidEnabled);
    if (cands.length === 0) return 0;

    var kp = killers[ply] || [];
    // killer 走法前置（move ordering）
    var ordered = [];
    for (var ki = 0; ki < kp.length; ki++) {
      for (var ci = 0; ci < cands.length; ci++) {
        if (cands[ci].x === kp[ki].x && cands[ci].y === kp[ki].y) { ordered.push(cands[ci]); break; }
      }
    }
    // 【2026-08-18 历史启发接入】killer 之后按历史表分数降序重排——
    // 之前 history 参数传了却不用，等于没做历史排序，同预算下搜索深度少 1-2 层。
    // 历史表记录"曾引发 β 截断"的走法，命中率高 → 排序靠前 → 剪枝更多 → 深度更深。
    var rest = [];
    for (ci = 0; ci < cands.length; ci++) {
      var dup = false;
      for (ki = 0; ki < ordered.length; ki++) {
        if (ordered[ki].x === cands[ci].x && ordered[ki].y === cands[ci].y) { dup = true; break; }
      }
      if (!dup) rest.push(cands[ci]);
    }
    rest.sort(function (a, b) {
      var ha = history[a.y * SIZE + a.x] || 0;
      var hb = history[b.y * SIZE + b.x] || 0;
      if (ha !== hb) return hb - ha; // 历史分数高者在前（降序）
      return b.s - a.s;              // 同分按启发分
    });
    ordered = ordered.concat(rest);

    var best = -Infinity;
    var origAlpha = alpha;
    for (var i = 0; i < ordered.length; i++) {
      if (Date.now() > deadline) break;
      var c = ordered[i];
      set(board, c.x, c.y, me);
      var v = -negamax(board, opp(me), depth - 1, -beta, -alpha, deadline, ply + 1, killers, history, forbidEnabled, tt);
      set(board, c.x, c.y, EMPTY);
      if (v > best) best = v;
      if (v > alpha) alpha = v;
      if (alpha >= beta) {
        // 记录 killer（两个槽位，去重）
        var exists = false;
        for (ki = 0; ki < kp.length; ki++) if (kp[ki].x === c.x && kp[ki].y === c.y) { exists = true; break; }
        if (!exists) {
          kp.push({ x: c.x, y: c.y });
          if (kp.length > 2) kp.shift();
          killers[ply] = kp;
        }
        // 【2026-08-18 历史启发写入】β 截断说明该走法是"杀棋/好手"，累加历史分
        history[c.y * SIZE + c.x] = (history[c.y * SIZE + c.x] || 0) + depth * depth;
        break;
      }
    }

    // ── 回存置换表（精确 / 上界 / 下界，深度 = 当前剩余 depth）──
    if (tt && Date.now() <= deadline) {
      var flag = 1;
      if (best <= origAlpha) flag = 2;      // 上界
      else if (best >= beta) flag = 3;      // 下界
      tt.set(h, { v: best, depth: depth, flag: flag });
    }
    return best;
  }

  /** 扰动：段位越低，从 topK 中随机挑。 */
  function maybeNoise(cands, noise, bestMove) {
    if (noise <= 0 || cands.length <= 1) return bestMove;
    if (Math.random() < noise) {
      var k = Math.max(1, Math.min(cands.length, Math.ceil(noise * 12)));
      return cands[Math.floor(Math.random() * k)];
    }
    return bestMove;
  }

  /**
   * 对外主入口 v3。签名兼容 v2：
   * getBestMove(board, player, level, deadline, forbidEnabled)
   */
  function getBestMove(board, player, level, deadline, forbidEnabled, history) {
    level = Math.max(1, Math.min(9, level | 0));
    var cfg = LEVELS[level - 1];
    // 【2026-08-18 穷举深度】按段位设定杀棋链搜索深度：九段 VCF/VCT 更深，
    // "连冲四→收网"的远距离必胜链才能被完整穷举出来（8 层 ≈ 连续 8 次冲四）。
    var killDepth = level >= 7 ? 8 : (level >= 4 ? 6 : 4);
    // 【2026-08-16 实验】GOMOKU_DEPTH 临时覆盖搜索深度（测"加深搜索"的真实收益，
    // 决定是否永久改 LEVELS 九段配置，以及要不要 Web Worker 化）
    if (typeof process !== 'undefined' && process.env.GOMOKU_DEPTH) {
      cfg = Object.assign({}, cfg, { depth: parseInt(process.env.GOMOKU_DEPTH, 10) });
    }
    var dl = deadline || Date.now() + TIME_BUDGETS[level - 1];

    // 空盘：落天元
    var near0 = collectNear(board);
    if (near0.length === 0) {
      if (level <= 3 && Math.random() < 0.2) {
        return { x: 7 + (Math.random() < 0.5 ? -1 : 1), y: 7 + (Math.random() < 0.5 ? -1 : 1) };
      }
      return { x: 7, y: 7 };
    }

    // 【2026-08-18 黑先手强开局定式】AI 执黑且开局（已落 ≤5 子）时，
    // 用已知必胜型开局占优：黑 1 天元（已有）、黑 3/黑 5 下在"天元 + 对称/邻位"的强形点。
    // 定式表：以天元(7,7)为中心的高潜力开局点（斜连/直连双活二起手）。
    // 只在 AI 执黑且非禁手规则（禁手开启时双活三无效）下启用，防止自陷禁手。
    // 位置必须在"开局贴边应对"之前——否则 moveCount≤2 时对称点先命中，定式永远走不到。
    var moveCount = 0, i, j;
    for (i = 0; i < SIZE; i++) for (j = 0; j < SIZE; j++) if (get(board, i, j) !== EMPTY) moveCount++;
    // 【2026-08-18 黑开局定式】AI 执黑开局前 3 手用强开局点；黑5起交给搜索。
    // (2026-08-18 实测回退说明：给黑额外 +2 强制链深度 / 长定式会拖垮时限、反遭白方背谱，
    //  故仅保留"天元 + 黑3斜位"短定式，黑5起完全交给搜索——基础强化(深度/历史启发)才是胜率主力)
    if (player === BLACK && !forbidEnabled && moveCount <= 3 && level >= 5) {
      var blackStones = 0;
      for (i = 0; i < SIZE; i++) for (j = 0; j < SIZE; j++) if (get(board, i, j) === BLACK) blackStones++;
      if (blackStones === 0) {
        if (get(board, 7, 7) === EMPTY) return { x: 7, y: 7 }; // 黑1 天元
      } else if (blackStones === 1 && get(board, 7, 7) === BLACK) {
        // 黑3：天元在手 → 斜对角强点（不同行不同列），若被占则就近标准强点
        var OPEN_BLACK = [[7, 8], [8, 7], [6, 7], [7, 6], [6, 8], [8, 6], [6, 6], [8, 8], [5, 7], [7, 5]];
        var best = null;
        for (var ob = 0; ob < OPEN_BLACK.length; ob++) {
          var ox = OPEN_BLACK[ob][0], oy = OPEN_BLACK[ob][1];
          if (get(board, ox, oy) !== EMPTY) continue;
          if (ox !== 7 && oy !== 7) return { x: ox, y: oy }; // 斜位优先
          if (!best) best = [ox, oy];
        }
        if (best) return { x: best[0], y: best[1] };
      }
    }

    // 开局贴边应对（前 2 手，对手没占天元时；AI 执黑已被上方定式优先拦截）
    if (moveCount <= 2 && level >= 3 && !(player === BLACK)) {
      for (i = 0; i < SIZE; i++) {
        for (j = 0; j < SIZE; j++) {
          if (get(board, i, j) === opp(player) && (i !== 7 || j !== 7)) {
            var mx = 7 - (i - 7), my = 7 - (j - 7);
            if (inB(mx, my) && get(board, mx, my) === EMPTY) return { x: mx, y: my };
          }
        }
      }
    }

    var cands = genCandidates(board, player, near0, cfg.cand, forbidEnabled);
    // 【AlphaZero 融合】网络 policy top-6 并入候选池（模型进化后影响选点；缺失时原引擎不变）
    if (history && history.length >= 4) {
      cands = fuseNetCandidates(board, player, history, cands, cfg.cand);
    }
    if (cands.length === 0) {
      // 全盘无合法点（罕见）：退回最近空点
      for (i = 0; i < SIZE; i++) for (j = 0; j < SIZE; j++) if (get(board, i, j) === EMPTY) return { x: i, y: j };
      return { x: 7, y: 7 };
    }

    // 威胁决策层（高段位全开，低段位按概率）
    if (cfg.threat > 0) {
      var dec = threatDecide(board, player, cands, forbidEnabled);
      if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] dec:', dec && dec.kind, dec && String.fromCharCode(65 + dec.move.x) + (dec.move.y + 1));
      // 【2026-08-21 威胁竞速守卫】对方活三在盘且我方无活三+先手 → 确定性堵活三，
      // 不进入搜索/破平（棋谱 2026-08-21：黑 21 漏防白 20 单活三，白 22 活四 →
      // 白 24 五连）。运行条件：dec 为 null（无 force 级决策），或 dec 为 op-force
      // 且是"活四成型点"（对方落该点即活四，rank4——活三的活四端，守卫可覆盖）。
      // op-win/my-win/my-force 更紧急、四三/双冲四（rank3）是复合威胁，均不覆盖。
      var raceRun = !dec || (dec.kind === 'op-force' && classifyPoint(board, dec.move.x, dec.move.y, opp(player)).live4 > 0);
      if (raceRun) {
        var race = threatRaceGuard(board, player, forbidEnabled);
        if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] race:', race && String.fromCharCode(65 + race.x) + (race.y + 1));
        if (race) return race;
      }
      if (dec) {
        var decMove = dec.move;
        // 进攻优先（高段位）：对方存在活四/双杀成型点（op-force）时，
        // 若我方有"落子后形成五连/活四成型点"的 VCF 先手点（如棋谱11 白 G6 → I6 五连），
        // 先手威胁比防守更急——对方必须先应我，否则我下一步成型；
        // 盲目防守（如白 G9）反而给对手留出占我方进攻点的机会。
        // 【2026-08-16 多候选】findVcfStarts 返回全部命中点逐个验证——首个命中
        // （如棋谱19 I8）验证失败不代表后续候选（I6，VCT 必胜链）也不行（曾只试第一个）。
        if (cfg.threat >= 3 && dec.kind === 'op-force' && Date.now() < dl) {
          var atkList = findVcfStarts(board, player, cands, forbidEnabled, Math.min(dl, Date.now() + 150));
          for (var ai2 = 0; ai2 < atkList.length && Date.now() < dl; ai2++) {
            // 先手有效性验证：对手应五连成型点后，我仍能防住其全部 force 威胁才走先手；
            // 虚先手（防不完）退回防守（棋谱13/14 白 N4、棋谱11 白 G6 均为虚先手）。
            if (vcfStartUsable(board, player, atkList[ai2], forbidEnabled, Math.min(dl, Date.now() + 300), killDepth)) return atkList[ai2];
          }
        }
        // 多威胁裁决（高段位）：对方存在多个必胜成型点时，
        // 优先选"占后对方完全无杀（含两步 VCF 链）"的点——这是唯一能真正防住的点。
        // 若所有成型点占后对方仍有杀，退回预防源头点。
        if (cfg.threat >= 3 && Date.now() < dl &&
            (dec.kind === 'op-force' || dec.kind === 'op-win')) {
          var opPts = collectOpForce(board, player, cands, forbidEnabled, 8);
          if (opPts.length > 1) {
            var bestPt = null;
            for (var pi = 0; pi < opPts.length; pi++) {
              if (Date.now() > dl) break;
              var pt = opPts[pi];
              if (get(board, pt.x, pt.y) !== EMPTY) continue;
              set(board, pt.x, pt.y, player); // 占住该成型点
              // 两步 VCF 链检测：占后对方是否仍有杀（depth 3 = 两次冲四 + 收网）
              var still = vcfSearch(board, opp(player), 3, forbidEnabled, dl);
              set(board, pt.x, pt.y, EMPTY);
              if (!still) { bestPt = pt; break; } // 占后对方无杀 → 完美防守点
            }
            if (bestPt) return bestPt;
            // 所有成型点占后对方仍有杀（活四/双杀无解）→ 退回原始必防点（方向正确即可）
            return decMove;
          }
          // 单必胜点：对方落此点即一步必胜（活四/四三/双杀），必须优先占住。
          // 占后对方改走其他点仍有杀，那是下一轮的防守问题，不能因预防层改走他处——
          // 否则等于放掉当前的一步必胜威胁（棋谱7：黑 F10 四三必胜，白须占 F10；
          // 棋谱8：黑 C12 后 C11 活四成型点，白须占 C11，改走 D13 会让黑 C11 活四无解）。
          return decMove;
        }
        // 低段位偶尔也放过必胜（制造失误感），高段位必走
        if (cfg.threat >= 2 || Math.random() < 0.9) return decMove;
      }
    }

    // VCF 连续冲四搜索（高段位）：多步杀（2026-08-18：深度按段位 killDepth，九段 8 层穷举）
    if (cfg.threat >= 2) {
      var vcfMove = vcfSearch(board, player, killDepth, forbidEnabled, dl);
      if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] vcfWhite:', vcfMove && String.fromCharCode(65 + vcfMove.x) + (vcfMove.y + 1));
      if (vcfMove) return vcfMove;
      // 防守：对方存在 VCF → 占据对方杀棋起点
      var oppVcf = vcfSearch(board, opp(player), killDepth, forbidEnabled, dl);
      if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] oppVcf:', oppVcf && String.fromCharCode(65 + oppVcf.x) + (oppVcf.y + 1));
      if (oppVcf) {
        // 起点验证：对方落该起点后是否构成"无解杀"（活四成型/双杀）？
        // 若只是单冲四链（如棋谱9 黑 E6 冲四，缺口可堵、链可连续防），
        // 说明另有更致命的源头（如黑 H13 落子后 I14 五连 + F13 活四双杀），
        // 交给预防层选"断链最多的点"（占 H13 同时断两条链）。
        var opStart = threatAfter(board, player, oppVcf, forbidEnabled, dl);
        if (opStart) {
          // 【2026-08-16 源头验证】白占该起点后，黑改走其他候选点是否仍启动无解杀？
          // 棋谱17：黑 E9 被 vcfSearch 判为链起点，但白占 E9 后黑 G12（G 列跳四缺口 G11
          // + F11 四三预埋双威胁）仍杀 → E9 非真源头，白 24 正解是占 F11（四三成型点）。
          set(board, oppVcf.x, oppVcf.y, player);
          var still = false;
          var srcCands = genCandidates(board, opp(player), collectNear(board), 10, forbidEnabled);
          for (var si = 0; si < srcCands.length && !still; si++) {
            if (Date.now() > dl) break;
            var sc = srcCands[si];
            if (get(board, sc.x, sc.y) !== EMPTY) continue;
            if (threatAfter(board, player, sc, forbidEnabled, dl)) still = true;
          }
          set(board, oppVcf.x, oppVcf.y, EMPTY);
          if (!still) return oppVcf;
        }
      }
      // 预防性防守（高段位）：对方落某个候选点后将获得 VCF 必胜链 →
      // 我方抢先占据该源头点（如 M9/K11 双线交叉、K11 斜线成型位）
      // 仅在中盘以后启用（<10 子时无必胜结构，预防层会误判拖累早期棋力）
      // 【2026-08-18 进攻优先守卫】我方有成型攻击先手（force>=2：双活三/四三/活四）
      // 时跳过预防层——先手压制比预埋防守更快，预防层抢先会把必胜节奏顶成被动防守
      // （例：白双活三 H8 被 prevent J12 顶掉；跳过预防后搜索直接取 H8 必胜）。
      var myInitiative = hasWinningInitiative(board, player, forbidEnabled);
      if (!myInitiative && cfg.threat >= 3 && Date.now() < dl && moveCount >= 10) {
        var prevDl = Math.min(dl, Date.now() + 350);
        var prev = preventVcfDecide(board, player, cands.slice(0, 16), forbidEnabled, prevDl);
        if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] prevent:', prev && String.fromCharCode(65 + prev.x) + (prev.y + 1));
        if (prev) return prev;
      }
    }
    // 【2026-08-16 两步威胁预防（高段位）】对方落 c 后（c 静态无威胁、启发分低，搜索难发现），
    // 存在 q：落 q 后形成四三/活四/双冲四（force rank>=3）→ 两步杀。
    // 棋谱17：黑 G12（跳二预埋）→ F11（E10-F11-G12 活三 + F11-G10-H9-I8 冲四 = 四三），
    // 白 24 若走 E9 活三被黑 G12→F11 链 31 手杀；占 F11（成型点）才能顶住。
    // 【2026-08-18 进攻优先守卫】同预防层：我方有成型攻击先手时让搜索权衡进攻，
    // 两步预埋防御不抢先（双活三先手赢在两步预埋之前）。
    if (!myInitiative && cfg.threat >= 3 && Date.now() < dl && moveCount >= 10) {
      var twoDl = Math.min(dl, Date.now() + 250);
      var two = findOpTwoStep(board, player, forbidEnabled, twoDl);
      if (typeof process !== 'undefined' && process.env.GOMOKU_DBG) console.log('[dbg] two-step:', two && String.fromCharCode(65 + two.x) + (two.y + 1));
      if (two) return two;
    }
    // 【2026-08-16 回退】全局主动进攻（threatDecide null 时查活四/五连成型点）曾实现，
    // 实测九段 0:5 输八段（12 手）——决策层抢搜索的活：活三/活四价值搜索评估已编码，
    // depth 6 能发现活四链；决策层重复干预反而破坏布局/漏防。全局进攻交给搜索。

    // 迭代加深搜索（置换表跨深度复用：上一深度的精确/边界值供下一深度剪枝）
    var killers = [];
    var history = {};
    var tt = new Map(); // Zobrist 哈希 → {v, depth, flag}
    var bestMove = cands[0];
    var bestScore = -Infinity;
    for (var depth = 1; depth <= cfg.depth; depth++) {
      if (Date.now() > dl) break;
      var alpha = -Infinity, beta = Infinity;
      var curBest = null, curScore = -Infinity;
      var moved = false;
      for (var k = 0; k < cands.length; k++) {
        if (Date.now() > dl) break;
        var c2 = cands[k];
        set(board, c2.x, c2.y, player);
        var v = -negamax(board, opp(player), depth - 1, -beta, -alpha, dl, 1, killers, history, forbidEnabled, tt);
        set(board, c2.x, c2.y, EMPTY);
        if (v > curScore) { curScore = v; curBest = c2; }
        if (v > alpha) alpha = v;
        moved = true;
      }
      if (curBest) { bestMove = curBest; bestScore = curScore; }
      if (moved && bestScore >= SCORE.WIN - 1000) break; // 已发现必胜，不再加深
    }

    // 【2026-08-18 根节点进攻活性破平】搜索分数几乎相等的候选中，优先选提升己方
    // 威胁等级的进攻点（活三/冲四/活四/双活二成型）。守卫（顺序不能反）：
    // ① 对手存在即时威胁（冲四/活四/成五点成型点）时跳过——必防优先，不许送杀；
    // ② 已发现一步必胜时不再破平（myWin 由决策层返回、搜索也以 WIN 级截断）。
    if (cfg.threat >= 2 && bestScore < SCORE.WIN - 1000 &&
        !hasImmediateOppThreat(board, player, forbidEnabled)) {
      bestMove = pickActiveTieBreak(board, player, cands, bestMove, forbidEnabled);
    }

    return maybeNoise(cands, cfg.noise, bestMove);
  }

  var api = {
    getBestMove: getBestMove,
    LEVELS: LEVELS,
    TIME_BUDGETS: TIME_BUDGETS,
    // 导出供测试
    _classify: classifyPoint,
    _threat: threatLevel,
    _forbid: isForbidMove,
    _evaluate: evaluateBoard,
    _raceGuard: threatRaceGuard,
    _useNet: setNet,
    _netReady: netReady
  };
  global.GomokuAI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
