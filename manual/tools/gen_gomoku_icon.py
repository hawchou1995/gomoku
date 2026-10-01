# -*- coding: utf-8 -*-
"""生成五子棋手游级「五子连珠」启动图标（纯标准库，v6 手游质感升级版）：
1. 自适应图标前景层 drawable-*/ic_launcher_foreground.png —— Android 8+ 前景
   （108dp 画布、透明底、微立体棋盘 + 细腻金边 + 榧木纹理 + 曜石高光五连珠 + 胜利金色光华）；
2. 自适应背景层 drawable/ic_launcher_background.xml —— 暖色渐变实木质感；
3. 低版本回退 mipmap-*/ic_launcher.png —— Android 7-（带圆角抗锯齿遮罩的完整手游拟物图标）。

设计特点（基于 taste-skill / brandkit 审美）：
- 材质：高端榧木盘面质感，带微妙年轮纹理起伏与四周高光斜切倒角（Chamfer）；
- 金线：网格四周边框内衬雅致金线（Gold Inlay），极具国风雅韵与商业手游品质；
- 棋子：五颗曜石黑子沿主对角线五子连珠，带有双重漫反射曲面、曜石高光与底部接触阴影；
- 胜利光华：连珠五子下方带有典雅的胜利金色微辉光（Golden Renju Aura），传达五子成珠的决胜时刻；
- 分辨率自适应：纯数学抗锯齿渲染，从 48px 到 432px 保持极佳锐度与微质感。
"""
import struct, zlib, os, math

# ---- 调色板（雅致新国风榧木手游色系）----
BG_TOP     = (249, 226, 196)   # 顶部受光榧木色
BG_MID     = (242, 212, 178)   # 中心榧木色
BG_BOT     = (226, 191, 153)   # 底部暗部榧木色
WOOD_DARK  = (214, 175, 134)   # 木纹深色条带
WOOD_LGT   = (252, 233, 209)   # 木纹浅色条带

GRID_LINE  = (112, 75, 42)     # 网格线条（温润深褐色，含墨色感）
GOLD_INLAY = (212, 168, 64)    # 雅致金边镶嵌色
GOLD_GLOW  = (255, 215, 80)    # 胜利金辉
STAR_POINT = (100, 65, 36)     # 星位（天元与星位）

STONE_BASE = (32, 30, 32)      # 曜石黑子基底
STONE_BODY = (48, 45, 48)      # 曜石受光面
STONE_SH   = (16, 14, 16)      # 曜石背光暗面
STONE_SPEC = (255, 255, 255)   # 曜石高光
STONE_RIM  = (180, 160, 140)   # 棋子边缘微弱环境反光

BEVEL_LGT  = (255, 250, 240)   # 棋盘顶部/左侧外倒角高光
BEVEL_DRK  = (120, 80, 45)     # 棋盘底部/右侧外倒角阴影

SHADOW_COL = (0, 0, 0)         # 投影底色

BOARD_FRAC = 0.94              # 棋盘边长占画布比例（94%，留出精细边缘倒角）
CORNER_R   = 22.0 / 108.0      # 圆角半径占画布比例（22dp / 108dp）


def make_grid(PX, bg=None):
    """PX×PX 像素网格；bg=None 时全透明，否则填 bg（RGB）。"""
    if bg is None:
        return [[None] * PX for _ in range(PX)]
    return [[bg + (255,)] * PX for _ in range(PX)]


def blend(grid, PX, x, y, c, a):
    """把颜色 c 以不透明度 a（0..1）按 over 算子混合进 (x, y) 像素。"""
    if not (0 <= x < PX and 0 <= y < PX) or a <= 0.0:
        return
    cur = grid[y][x]
    sa = max(0.0, min(1.0, a))
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
    """抗锯齿实心圆；clip=(ccx, ccy, cr) 时只画落在该圆内的部分。"""
    if r <= 0.0 or a <= 0.0:
        return
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
                if cov > 0.0:
                    blend(grid, PX, x, y, c, a * cov)


def fill_rect(grid, PX, x0, y0, x1, y1, c, a=1.0):
    """抗锯齿填充矩形。"""
    xlo, xhi = min(x0, x1), max(x0, x1)
    ylo, yhi = min(y0, y1), max(y0, y1)
    for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
        cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
        if cov_y <= 0.0:
            continue
        for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
            cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
            cov = cov_y * cov_x
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, a * cov)


def hline(grid, PX, y, x0, x1, c, w=1.0, a=1.0):
    """抗锯齿水平线，支持浮点线宽 w。"""
    hw = w / 2.0
    ylo, yhi = y - hw, y + hw
    xlo, xhi = min(x0, x1), max(x0, x1)
    for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
        cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
        if cov_y <= 0.0:
            continue
        for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
            cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
            cov = cov_y * cov_x
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, a * cov)


def vline(grid, PX, x, y0, y1, c, w=1.0, a=1.0):
    """抗锯齿垂直线，支持浮点线宽 w。"""
    hw = w / 2.0
    xlo, xhi = x - hw, x + hw
    ylo, yhi = min(y0, y1), max(y0, y1)
    for xx in range(max(0, int(math.floor(xlo))), min(PX, int(math.ceil(xhi)) + 1)):
        cov_x = max(0.0, min(1.0, min(xhi, xx + 0.5) - max(xlo, xx - 0.5)))
        if cov_x <= 0.0:
            continue
        for yy in range(max(0, int(math.floor(ylo))), min(PX, int(math.ceil(yhi)) + 1)):
            cov_y = max(0.0, min(1.0, min(yhi, yy + 0.5) - max(ylo, yy - 0.5)))
            cov = cov_x * cov_y
            if cov > 0.0:
                blend(grid, PX, xx, yy, c, a * cov)


def line(grid, PX, x0, y0, x1, y1, c, w=1.0, a=1.0):
    """绘制平滑抗锯齿线段。"""
    length = math.hypot(x1 - x0, y1 - y0)
    if length <= 0.001:
        return
    steps = max(2, int(length * 2.5))
    hw = w / 2.0
    for i in range(steps + 1):
        t = i / float(steps)
        cx = x0 + t * (x1 - x0)
        cy = y0 + t * (y1 - y0)
        circle(grid, PX, cx, cy, hw, c, a)


def render_wood_plate(grid, PX, ox, oy, size):
    """渲染具有自然年轮微起伏与精细斜切倒角的实木底板。"""
    # 逐行渐变与微木纹
    for y_idx in range(int(math.floor(oy)), int(math.ceil(oy + size))):
        if not (0 <= y_idx < PX):
            continue
        v = (y_idx - oy) / float(size)
        v = max(0.0, min(1.0, v))
        # 竖向整体渐变（微逆光：顶部稍亮，底部稍沉）
        r0 = BG_TOP[0] * (1.0 - v) + BG_BOT[0] * v
        g0 = BG_TOP[1] * (1.0 - v) + BG_BOT[1] * v
        b0 = BG_TOP[2] * (1.0 - v) + BG_BOT[2] * v
        # 微木纹波动（正弦波模拟木材年轮）
        grain = math.sin((y_idx - oy) * 0.35 + math.sin((y_idx - oy) * 0.12) * 2.0)
        if grain > 0:
            factor = grain * 0.035
            c = (min(255, int(r0 + (WOOD_LGT[0] - r0) * factor)),
                 min(255, int(g0 + (WOOD_LGT[1] - g0) * factor)),
                 min(255, int(b0 + (WOOD_LGT[2] - b0) * factor)))
        else:
            factor = (-grain) * 0.045
            c = (max(0, int(r0 + (WOOD_DARK[0] - r0) * factor)),
                 max(0, int(g0 + (WOOD_DARK[1] - g0) * factor)),
                 max(0, int(b0 + (WOOD_DARK[2] - b0) * factor)))
        fill_rect(grid, PX, ox, y_idx, ox + size, y_idx + 1, c, 1.0)

    # 3D 倒角高光与暗边（木质边缘斜切）
    bw = max(1.0, size * 0.018)
    # 顶部与左侧斜切高光
    hline(grid, PX, oy + bw * 0.5, ox, ox + size, BEVEL_LGT, w=bw, a=0.55)
    vline(grid, PX, ox + bw * 0.5, oy, oy + size, BEVEL_LGT, w=bw, a=0.55)
    # 底部与右侧斜切背光投影
    hline(grid, PX, oy + size - bw * 0.5, ox, ox + size, BEVEL_DRK, w=bw, a=0.45)
    vline(grid, PX, ox + size - bw * 0.5, oy, oy + size, BEVEL_DRK, w=bw, a=0.45)


def luxury_stone(grid, PX, cx, cy, r):
    """画一颗带有曜石光泽与立体球形漫反射的五子棋黑子。"""
    k = r / 3.0
    # 1. 柔和接触阴影（分两层：近身紧密深阴影 + 远端扩散软阴影）
    circle(grid, PX, cx + 0.9 * k, cy + 1.1 * k, r + 0.6 * k, SHADOW_COL, 0.22)
    circle(grid, PX, cx + 0.5 * k, cy + 0.6 * k, r + 0.15 * k, SHADOW_COL, 0.35)

    # 2. 曜石棋子主体底色
    circle(grid, PX, cx, cy, r, STONE_BASE, 1.0)

    # 3. 球形漫反射亮面（左上偏移亮面）
    circle(grid, PX, cx - 0.35 * k, cy - 0.35 * k, r - 0.2 * k, STONE_BODY, 0.70)

    # 4. 右下方月牙形暗部
    circle(grid, PX, cx + 0.65 * k, cy + 0.65 * k, r - 0.1 * k, STONE_SH, 0.55, clip=(cx, cy, r))

    # 5. 右下方极弱环境反光（模拟木质盘面反射到黑子底部的微光）
    circle(grid, PX, cx + 0.75 * k, cy + 0.75 * k, r * 0.85, STONE_RIM, 0.15, clip=(cx, cy, r))

    # 6. 左上方主高光与副高光
    circle(grid, PX, cx - 1.05 * k, cy - 1.05 * k, 0.85 * k, STONE_SPEC, 0.85)
    circle(grid, PX, cx - 1.25 * k, cy - 1.25 * k, 0.38 * k, STONE_SPEC, 1.0)


def draw_game_board(grid, PX, ox, oy, size, with_bg=True):
    """在 grid 上绘制新国风手游级五子连珠盘面。
    - with_bg=True 时渲染完整实木底板；
    - with_bg=False 时仅渲染网格、金线镶边与五子连珠，用于 Android 8+ 自适应前景层。
    """
    s = size / 24.0

    if with_bg:
        render_wood_plate(grid, PX, ox, oy, size)

    # 金色内衬边框（雅致金线，边距 1.8 逻辑单位）
    inlay_pad = 1.8 * s
    inlay_w = max(1.0, 0.32 * s)
    x0, y0 = ox + inlay_pad, oy + inlay_pad
    x1, y1 = ox + size - inlay_pad, oy + size - inlay_pad
    hline(grid, PX, y0, x0, x1, GOLD_INLAY, w=inlay_w, a=0.75)
    hline(grid, PX, y1, x0, x1, GOLD_INLAY, w=inlay_w, a=0.65)
    vline(grid, PX, x0, y0, y1, GOLD_INLAY, w=inlay_w, a=0.75)
    vline(grid, PX, x1, y0, y1, GOLD_INLAY, w=inlay_w, a=0.65)

    # 5x5 网格线（4, 8, 12, 16, 20）
    line_w = max(1.0, 0.28 * s)
    grid_coords = [4, 8, 12, 16, 20]
    for p in grid_coords:
        vline(grid, PX, ox + p * s, oy + 3.0 * s, oy + 21.0 * s, GRID_LINE, w=line_w, a=0.88)
        hline(grid, PX, oy + p * s, ox + 3.0 * s, ox + 21.0 * s, GRID_LINE, w=line_w, a=0.88)

    # 星位（天元 (12,12) 与四角星位 (8,8), (16,8), (8,16), (16,16)）
    star_r = max(1.2, 0.52 * s)
    star_points = [(8, 8), (16, 8), (12, 12), (8, 16), (16, 16)]
    for sx, sy in star_points:
        circle(grid, PX, ox + sx * s, oy + sy * s, star_r, STAR_POINT, 0.95)

    # 胜利金辉（Renju Victory Glow）：五子连珠对角线下的金色流光
    aura_x0 = ox + 4 * s
    aura_y0 = oy + 4 * s
    aura_x1 = ox + 20 * s
    aura_y1 = oy + 20 * s
    line(grid, PX, aura_x0, aura_y0, aura_x1, aura_y1, GOLD_GLOW, w=4.5 * s, a=0.18)
    line(grid, PX, aura_x0, aura_y0, aura_x1, aura_y1, (255, 235, 140), w=1.6 * s, a=0.35)

    # 五子连珠：主对角线全黑五连
    stone_r = 2.65 * s
    for i in range(5):
        cx = ox + (4 + i * 4) * s
        cy = oy + (4 + i * 4) * s
        luxury_stone(grid, PX, cx, cy, stone_r)

    # 决胜天元（中心第三颗连珠棋子）加冕微光小星芒（表达绝杀连珠）
    cx_center = ox + 12 * s
    cy_center = oy + 12 * s
    circle(grid, PX, cx_center - 1.25 * (stone_r / 3.0), cy_center - 1.25 * (stone_r / 3.0), 0.75 * s, GOLD_GLOW, 0.45)


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
    ccx = r if cx < r else (PX - r if cx > PX - r else cx)
    ccy = r if cy < r else (PX - r if cy > PX - r else cy)
    if ccx == cx and ccy == cy:
        return 1.0
    d = math.hypot(cx - ccx, cy - ccy)
    return max(0.0, min(1.0, r + 0.5 - d))


def round_corner_mask(grid, PX, radius):
    """把画布四角裁成圆角（radius 像素，抗锯齿）。"""
    r = radius
    for y in range(PX):
        for x in range(PX):
            cov = px_round(x, y, r, PX)
            cur = grid[y][x]
            if cov <= 0.0:
                grid[y][x] = None
            elif cov < 1.0 and cur is not None:
                grid[y][x] = (cur[0], cur[1], cur[2], round(cur[3] * cov))


def main():
    HERE = os.path.dirname(os.path.abspath(__file__))
    RES = os.path.normpath(os.path.join(HERE, '..', 'res'))

    # 1) 自适应图标前景层：108dp 画布，透明底，棋盘在 66dp 安全区内充分绽放
    FG_DENS = {'mdpi': 108, 'hdpi': 162, 'xhdpi': 216, 'xxhdpi': 324, 'xxxhdpi': 432}
    for d, px in FG_DENS.items():
        grid = make_grid(px)
        # 前景层在自适应图标中安全视距内（约占 78% 画布，确保在任何圆形/水滴形裁剪下完整可见）
        fg_frac = 0.78
        size = px * fg_frac
        ox = (px - size) / 2.0
        draw_game_board(grid, px, ox, ox, size, with_bg=False)
        out = os.path.join(RES, 'drawable-' + d, 'ic_launcher_foreground.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        write_png(out, grid, px)
        print('foreground written:', out, f'{px}x{px}')

    # 2) 低版本回退：满幅实木棋盘 + 圆角遮罩（Android 7-，手游拟物观感）
    LEGACY_DENS = {'mdpi': 48, 'hdpi': 72, 'xhdpi': 96, 'xxhdpi': 144, 'xxxhdpi': 192}
    for d, px in LEGACY_DENS.items():
        grid = make_grid(px)
        size = px * BOARD_FRAC
        ox = (px - size) / 2.0
        draw_game_board(grid, px, ox, ox, size, with_bg=True)
        round_corner_mask(grid, px, px * CORNER_R)
        out = os.path.join(RES, 'mipmap-' + d, 'ic_launcher.png')
        os.makedirs(os.path.dirname(out), exist_ok=True)
        write_png(out, grid, px)
        print('legacy written:', out, f'{px}x{px}')

    # 3) 移除旧矢量前景（确保 aapt2 编译与链接无冲突）
    old = os.path.join(RES, 'drawable', 'ic_launcher_foreground.xml')
    if os.path.exists(old):
        os.remove(old)
        print('removed old vector:', old)


if __name__ == '__main__':
    main()
