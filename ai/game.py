# -*- coding: utf-8 -*-
"""
五子棋规则 + AlphaZero 特征编码（与 JS 端 engine.js 对齐）。
参考 initial-h/AlphaZero_Gomoku_MPI（game_board.py）：
- 15x15 棋盘，黑先（BLACK=1），无禁手
- 特征平面：4 个当前玩家历史平面 + 4 个对手历史平面（最近 8 步，与参考项目一致）
"""
import numpy as np

SIZE = 15
BLACK = 1
WHITE = -1
EMPTY = 0


class Game:
    def __init__(self):
        self.board = np.zeros((SIZE, SIZE), dtype=np.int8)
        self.current = BLACK  # 黑先
        self.history = []     # [(x, y, player), ...] 最近落子序列
        self.winner = 0
        self.last_move = None

    def clone(self):
        g = Game()
        g.board = self.board.copy()
        g.current = self.current
        g.history = list(self.history)
        g.winner = self.winner
        g.last_move = self.last_move
        return g

    def legal_moves(self):
        """所有空点 (x, y)"""
        ys, xs = np.where(self.board == EMPTY)
        return list(zip(xs.tolist(), ys.tolist()))

    def move_count(self):
        return len(self.history)

    def place(self, x, y, player):
        assert self.board[y, x] == EMPTY, f"({x},{y}) 已有子"
        self.board[y, x] = player
        self.history.append((x, y, player))
        self.last_move = (x, y)
        if self._check_win(x, y, player):
            self.winner = player
        self.current = -player

    def _check_win(self, x, y, player):
        board = self.board
        for dx, dy in ((1, 0), (0, 1), (1, 1), (1, -1)):
            cnt = 1
            nx, ny = x + dx, y + dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == player:
                cnt += 1
                nx += dx
                ny += dy
            nx, ny = x - dx, y - dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == player:
                cnt += 1
                nx -= dx
                ny -= dy
            if cnt >= 5:
                return True
        return False

    def is_end(self):
        """返回 (是否结束, 胜者) —— 平局=满盘"""
        if self.winner != 0:
            return True, self.winner
        if len(self.history) >= SIZE * SIZE:
            return True, 0
        return False, 0

    # ---------- AlphaZero 特征编码 ----------
    def encode_state(self):
        """
        8 个 15x15 平面：
          planes[0:4]  当前玩家最近 4 步（plane i = 第 i 新的当前方棋子）
          planes[4:8]  对手最近 4 步
        与 AlphaZero_Gomoku_MPI 的 4+4 结构一致（可扩展为 8+8）。
        """
        planes = np.zeros((8, SIZE, SIZE), dtype=np.float32)
        cur_steps = [m for m in self.history if m[2] == self.current][-4:]
        opp_steps = [m for m in self.history if m[2] == -self.current][-4:]
        for i, (x, y, _) in enumerate(cur_steps):
            planes[i, y, x] = 1.0
        for i, (x, y, _) in enumerate(opp_steps):
            planes[4 + i, y, x] = 1.0
        return planes

    def encode_state_simple(self):
        """2 平面简化版（当前方/对方全部子）——训练初期可选，速度更快"""
        planes = np.zeros((2, SIZE, SIZE), dtype=np.float32)
        planes[0] = (self.board == self.current).astype(np.float32)
        planes[1] = (self.board == -self.current).astype(np.float32)
        return planes


DIRS4 = ((1, 0), (0, 1), (1, 1), (1, -1))


def heuristic_scores(game, legal):
    """
    ego 式棋形先验（JS classifyPoint 的简化移植）：对每个合法点评估
    "我落该点"与"对手落该点"的棋形威胁分（连续段 + 开放端，不含跳形）。
    用于 MCTS 先验混合（训练加速：自对弈从"会下棋"起步而非随机）。
    """
    board = game.board
    me = game.current
    you = -me
    scores = []
    for x, y in legal:
        s = 1.0
        dist = abs(x - 7) + abs(y - 7)
        s *= (1 + 2.5 / (1 + dist))  # 中心倾向
        # 我方视角
        board[y, x] = me
        for dx, dy in DIRS4:
            cnt, ol, orr = 1, 0, 0
            nx, ny = x + dx, y + dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == me:
                cnt += 1; nx += dx; ny += dy
            if 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == EMPTY:
                orr = 1
            nx, ny = x - dx, y - dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == me:
                cnt += 1; nx -= dx; ny -= dy
            if 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == EMPTY:
                ol = 1
            s += _shape_score(cnt, ol, orr)
        board[y, x] = you
        # 对手视角（防守意识）
        for dx, dy in DIRS4:
            cnt, ol, orr = 1, 0, 0
            nx, ny = x + dx, y + dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == you:
                cnt += 1; nx += dx; ny += dy
            if 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == EMPTY:
                orr = 1
            nx, ny = x - dx, y - dy
            while 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == you:
                cnt += 1; nx -= dx; ny -= dy
            if 0 <= nx < SIZE and 0 <= ny < SIZE and board[ny, nx] == EMPTY:
                ol = 1
            s += 0.9 * _shape_score(cnt, ol, orr)
        board[y, x] = EMPTY
        scores.append(s)
    return scores


def _shape_score(cnt, ol, orr):
    """连续段棋形分（与 JS 启发式评分对齐）"""
    open_n = (1 if ol else 0) + (1 if orr else 0)
    if cnt >= 5:
        return 2000000
    if cnt == 4:
        return 1000000 if open_n == 2 else (300000 if open_n == 1 else 0)
    if cnt == 3:
        return 80000 if open_n == 2 else (5000 if open_n == 1 else 0)
    if cnt == 2:
        return 800 if open_n == 2 else 0
    return 0
