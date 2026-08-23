# -*- coding: utf-8 -*-
"""生成五子棋「五子连珠」启动图标（纯标准库，v5）：
1. 自适应图标前景层 drawable-*/ic_launcher_foreground.png —— Android 8+ 前景
   （108dp 画布、透明底、棋盘网格线 + 主对角线五颗黑子，棋子内收安全区）；
2. 自适应背景层 drawable-*/ic_launcher_background.png —— 满幅木色（棋盘底），
   配合前景层合成「圆角木色棋盘」图标——无深色黑底（用户 v1.2.0 反馈）；
3. 低版本回退 mipmap-*/ic_launcher.png —— Android 7-（满幅木色棋盘 + 圆角遮罩）。

v5 相对 v4 的变更（v1.2.1 · 去掉「深色底 + 居中棋盘」构图，棋盘铺满）：
- 删除深色背景 DARK：图标主体 = 木色棋盘铺满整幅（不再有近黑背景占比 69% 的问题）；
- 前景层只画网格线与棋子（透明底，木色由背景层提供）→ 合成即圆角木棋盘；
- 低版本回退：实木棋盘满幅 + 圆角遮罩（四角透明），无黑底。

v4 相对 v3 的变更（v1.2.0 · 圆角做进资源本身，不再依赖系统遮罩）：
- 低版本回退 PNG 深色底改为圆角矩形（四角透明，圆角半径 22dp/108dp）；
  三星桌面若按「原始形状」显示图标（不套系统遮罩），图标也不再是直角正方形；
- 前景层 PNG 保持透明底 + 居中棋盘（内容本身在安全区内，天然圆角兼容）。

设计说明（沿用 v2 的五子连珠）：
- 24x24 逻辑画布，浅木色棋盘底 + 5x5 深棕网格线，边缘留出棋盘边；
- 五颗棋子沿主对角线（左上→右下）连成一线（五子连珠），落子黑先：
  全黑五连（同色五连，严格符合五子棋规则）；
- 立体感：每颗棋子先画右下方投影再画本体；黑子带左上白高光 + 亮芯与
  右下暗部；
- 圆形采用抗锯齿覆盖率（smooth 边缘），直接以目标分辨率渲染，放大后
  边缘干净，不会呈马赛克糊点。
"""
import struct, zlib, os, math

# ---- 调色板（与 v2/v3 一致）----
BG       = (247, 218, 187)   # 浅木色棋盘底
GRID     = (122, 92, 58)     # 棋盘网格线（深棕）
BLACK    = (52, 50, 52)      # 黑子
BLACK_SH = (16, 15, 17)      # 黑子暗部
WHITE    = (250, 248, 244)   # 白子
WHITE_SH = (150, 148, 148)   # 白子暗部
EDGE     = (52, 50, 48)      # 白子深色描边
HILITE   = (255, 255, 255)   # 高光
SHADOW   = (0, 0, 0)         # 投影
SHADOW_A = 0.28              # 投影透明度
DARK     = (15, 17, 21)      # 深色背景 #0F1115（与站点 theme-color 一致）

BOARD_FRAC = 0.96            # 【v5】棋盘边长占画布比例（96%，接近铺满；安全边距留 2%）
CORNER_R   = 22.0 / 108.0    # 圆角半径占画布比例（22dp / 108dp，约 20%，接近三星观感）


def make_grid(PX, bg=None):
    """PX×PX 像素网格；bg=None 时全透明（None 表示透明），否则填 bg（RGB）。"""
    if bg is None:
        return [[None] * PX for _ in range(PX)]
    return [[bg + (255,)] * PX for _ in range(PX)]


def blend(grid, PX, x, y, c, a):
    """把颜色 c 以不透明度 a（0..1）按 over 算子混合进 (x, y) 像素。"""
    if not (0 <= x < PX and 0 <= y < PX) or a <= 0.0:
        return
    cur = grid[y][x]
    sa = a
    if cur is None:
        grid[y][x] = (round(c[0] * sa), round(c[1] * sa), round(c[2] * sa), round(255 * sa))
        return
    r, g, b, da8 = cur
    da = da8 / 255.0
    out_a = sa + da * (1.0 - sa)
    if out_a <= 0.0:
        return
    out_r = (c[0] * sa + r * da * (1.0 - sa)) / out_a
    out_g = (c[1] * sa + g * da * (1.0 - sa)) / out_a
    out_b = (c[2] * sa + b * da * (1.0 - sa)) / out_a
    grid[y][x] = (round(out_r), round(out_g), round(out_b), round(255 * out_a))


def circle(grid, PX, cx, cy, r, c, a=1.0, clip=None):
    """抗锯齿实心圆；clip=(ccx, ccy, cr) 时只画落在该圆内的部分（用于局部暗部）。"""
    x0 = max(0, int(math.floor(cx - r - 1)))
    x1 = min(PX - 1, int(math.ceil(cx + r + 1)))
    y0 = max(0, int(math.floor(cy - r - 1)))
    y1 = min(PX - 1, int(math.ceil(cy + r + 1)))
    for y in range(y0, y1 + 1):
        for x in range(x0, x1 + 1):
            d = math.hypot(x + 0.5 - cx, y + 0.5 - cy)
            cov = max(0.0, min(1.0, r + 0.5 - d))
            if cov > 0.0:
                if clip is not None:
                    dc = math.hypot(x + 0.5 - clip[0], y + 0.5 - clip[1])
                    cov *= max(0.0, min(1.0, clip[2] + 0.5 - dc))
                blend(grid, PX, x, y, c, a * cov)


def hline(grid, PX, y, x0, x1, c):
    """抗锯齿水平线：中心线 y（浮点），x 从 x0 到 x1（浮点），线宽 1px。"""
    ylo, yhi = y - 0.5, y + 0.5
    xlo, xhi = min(x0, x1), max(x0, x1)
    for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
        cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
        if cov_y <= 0.0:
            continue
        for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
            cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
            cov = cov_y * cov_x
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, cov)


def vline(grid, PX, x, y0, y1, c):
    """抗锯齿垂直线：中心线 x（浮点），y 从 y0 到 y1（浮点），线宽 1px。"""
    xlo, xhi = x - 0.5, x + 0.5
    ylo, yhi = min(y0, y1), max(y0, y1)
    for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
        cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
        if cov_x <= 0.0:
            continue
        for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
            cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
            cov = cov_x * cov_y
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, cov)


def stone(grid, PX, cx, cy, r, kind):
    """画一颗棋子：kind='b' 黑子 / 'w' 白子；r 为半径（像素）。"""
    k = r / 2.5  # 相对 24 单位设计的缩放
    # 右下方投影（先画，本体盖住中央，四周露出投影边）
    circle(grid, PX, cx + 0.75 * k, cy + 0.75 * k, r + 0.45 * k, SHADOW, SHADOW_A)
    if kind == 'b':
        circle(grid, PX, cx, cy, r, BLACK)
        # 右下暗部（裁剪在棋子内）
        circle(grid, PX, cx + 0.7 * k, cy + 0.7 * k, r - 0.3 * k, BLACK_SH, 0.38, clip=(cx, cy, r))
        # 左上高光 + 亮芯
        circle(grid, PX, cx - 1.05 * k, cy - 1.05 * k, 1.05 * k, HILITE, 0.90)
        circle(grid, PX, cx - 1.35 * k, cy - 1.35 * k, 0.42 * k, HILITE, 1.0)
    else:
        # 白子：深色描边外圈 + 白色面
        circle(grid, PX, cx, cy, r, EDGE)
        circle(grid, PX, cx, cy, r - 0.7 * k, WHITE)
        # 右下浅灰暗部（裁剪在白面内）
        circle(grid, PX, cx + 0.6 * k, cy + 0.6 * k, r - 0.2 * k, WHITE_SH, 0.55, clip=(cx, cy, r - 0.7 * k))


def fill_rect(grid, PX, x0, y0, x1, y1, c):
    """抗锯齿填充矩形（浮点坐标）。"""
    xlo, xhi = min(x0, x1), max(x0, x1)
    ylo, yhi = min(y0, y1), max(y0, y1)
    for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
        cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
        if cov_y <= 0.0:
            continue
        for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
            cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
            cov = cov_x * cov_y
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, cov)


def draw_board(grid, PX, ox, oy, size, with_bg=True):
    """在 grid 上画五子连珠棋盘：左上角 (ox, oy)，边长 size（像素）。
    浅木色底 + 5x5 网格线（4/8/12/16/20，两端各多延 2 单位）+ 主对角线五颗黑子。
    with_bg=False 时只画网格线与棋子（透明底——自适应前景层用，木色由背景层提供）。"""
    s = size / 24.0
    if with_bg:
        # 棋盘底：浅木色填充（先画，网格线与棋子盖在上面）
        fill_rect(grid, PX, ox, oy, ox + size, oy + size, BG)
    for p in (4, 8, 12, 16, 20):
        vline(grid, PX, ox + p * s, oy + 2 * s, oy + 22 * s, GRID)
        hline(grid, PX, oy + p * s, ox + 2 * s, ox + 22 * s, GRID)
    # 五子连珠：主对角线（左上→右下），全黑五连（同色五连胜，符合规则）
    for i in range(5):
        stone(grid, PX, ox + (4 + i * 4) * s, oy + (4 + i * 4) * s, 2.5 * s, 'b')


def write_png(path, grid, PX):
    """写 RGBA PNG（color type 6）。"""
    rows = []
    for y in range(PX):
        row = bytearray()
        for x in range(PX):
            px = grid[y][x]
            if px is None:
                row += bytes((0, 0, 0, 0))
            else:
                row += bytes(px)
        rows.append(b'\x00' + bytes(row))

    def chunk(tag, data):
        return struct.pack('>I', len(data)) + tag + data + struct.pack('>I', zlib.crc32(tag + data) & 0xffffffff)

    ihdr = struct.pack('>IIBBBBB', PX, PX, 8, 6, 0, 0, 0)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', ihdr) + chunk(b'IDAT', zlib.compress(b''.join(rows), 9)) + chunk(b'IEND', b'')
    with open(path, 'wb') as f:
        f.write(png)


def px_round(x, y, r, PX):
    """单像素圆角覆盖率（0..1）：圆角矩形内 1，外 0，边缘抗锯齿。"""
    cx, cy = x + 0.5, y + 0.5
    if (r <= cx <= PX - r) and (r <= cy <= PX - r):
        return 1.0
    # 归属角：决定角圆心
    ccx = r if cx < r else (PX - r if cx > PX - r else cx)
    ccy = r if cy < r else (PX - r if cy > PX - r else cy)
    if ccx == cx and ccy == cy:
        return 1.0
    d = math.hypot(cx - ccx, cy - ccy)
    return max(0.0, min(1.0, r + 0.5 - d))


def round_corner_mask(grid, PX, radius):
    """把画布四角裁成圆角（radius 像素，抗锯齿）：
    圆角矩形之外置为透明（None）——圆角做进资源本身，不依赖系统遮罩。"""
    r = radius
    for y in range(PX):
        for x in range(PX):
            cov = px_round(x, y, r, PX)
            cur = grid[y][x]
            if cov <= 0.0:
                grid[y][x] = None
            elif cov < 1.0 and cur is not None:
                grid[y][x] = (cur[0], cur[1], cur[2], round(cur[3] * cov))


HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.normpath(os.path.join(HERE, '..', 'res'))

# 1) 自适应图标前景层：108dp 画布，透明底，棋盘 96% 满幅（木色底由背景层提供）
FG_DENS = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
for d, px in FG_DENS.items():
    grid = make_grid(px)
    size = px * BOARD_FRAC
    ox = (px - size) / 2.0
    draw_board(grid, px, ox, ox, size, with_bg=False)
    out = os.path.join(RES, 'drawable-' + d, 'ic_launcher_foreground.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out, grid, px)
    print('foreground written:', out, px, 'x', px)

# 2) 低版本回退：满幅木色棋盘 + 圆角遮罩（Android 7-，无深色底）
#    【v1.2.1】棋盘铺满整幅（96%），不再「深色底 + 居中棋盘」；四角圆角透明
LEGACY_DENS = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
for d, px in LEGACY_DENS.items():
    grid = make_grid(px)
    size = px * BOARD_FRAC
    ox = (px - size) / 2.0
    draw_board(grid, px, ox, ox, size, with_bg=True)
    round_corner_mask(grid, px, px * CORNER_R)
    out = os.path.join(RES, 'mipmap-' + d, 'ic_launcher.png')
    os.makedirs(os.path.dirname(out), exist_ok=True)
    write_png(out, grid, px)
    print('legacy written:', out, px, 'x', px)

# 3) 移除旧矢量前景（已被 PNG 取代；@drawable/ic_launcher_foreground 现在解析到 PNG）
old = os.path.join(RES, 'drawable', 'ic_launcher_foreground.xml')
if os.path.exists(old):
    os.remove(old)
    print('removed old vector:', old)
