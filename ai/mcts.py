# -*- coding: utf-8 -*-
"""
MCTS（AlphaZero 风格）——参考 initial-h/AlphaZero_Gomoku_MPI 的 mcts_alphaZero.py：
- UCB: Q + c_puct * P * sqrt(parent_N) / (1 + N)，c_puct = 5
- Dirichlet noise：alpha=0.3，权重 0.25，前 12 手（训练时逐节点加噪声）
- n_playout：训练 100~200，评估 400
"""
import math
import numpy as np


class TreeNode:
    def __init__(self, parent, prior):
        self.parent = parent
        self.prior = prior
        self.children = {}   # action -> TreeNode
        self.n_visits = 0
        self.total_value = 0.0

    def is_expanded(self):
        return len(self.children) > 0

    def value(self):
        return self.total_value / self.n_visits if self.n_visits else 0.0

    def select(self, c_puct):
        best = None
        best_score = -float("inf")
        for action, child in self.children.items():
            u = c_puct * child.prior * math.sqrt(self.n_visits) / (1 + child.n_visits)
            score = child.value() + u
            if score > best_score:
                best_score = score
                best = (action, child)
        return best

    def update(self, leaf_value):
        self.n_visits += 1
        self.total_value += leaf_value

    def update_recursive(self, leaf_value):
        if self.parent:
            self.parent.update_recursive(-leaf_value)
        self.update(leaf_value)


class MCTS:
    def __init__(self, policy_value_fn, c_puct=5.0, n_playout=200, dirichlet_alpha=0.3,
                 dirichlet_weight=0.25, noise_first_n=12, is_train=True, heuristic_fn=None):
        self.policy_value_fn = policy_value_fn  # (game) -> (probs, value)
        self.c_puct = c_puct
        self.n_playout = n_playout
        self.dirichlet_alpha = dirichlet_alpha
        self.dirichlet_weight = dirichlet_weight
        self.noise_first_n = noise_first_n
        self.is_train = is_train
        self.heuristic_fn = heuristic_fn  # (game, legal) -> [score,...]（ego 先验混合，可选）
        self.root = None
        self.root_game = None

    def _policy_with_noise(self, game, probs, legal_moves):
        if self.is_train and game.move_count() < self.noise_first_n:
            noise = np.random.dirichlet([self.dirichlet_alpha] * len(legal_moves))
            probs = (1 - self.dirichlet_weight) * probs + self.dirichlet_weight * noise
        return probs

    def playout(self, game):
        node = self.root
        g = game.clone()
        # selection
        while node.is_expanded() and not g.is_end()[0]:
            action, node = node.select(self.c_puct)
            g.place(action[0], action[1], g.current)
        # expansion + evaluation
        end, winner = g.is_end()
        if end:
            if winner == 0:
                leaf_value = 0.0
            else:
                leaf_value = 1.0 if winner == g.current else -1.0
            # 终局节点的 value 以当前视角（g.current 是下一位，胜者视角相反）
            leaf_value = 1.0 if winner == g.current else (-1.0 if winner != 0 else 0.0)
        else:
            probs, value = self.policy_value_fn(g)
            legal = g.legal_moves()
            if self.heuristic_fn is not None:
                hs = self.heuristic_fn(g, legal)
                # 先验 = policy^0.1 × 启发式^0.9（启发式主导起步，网络随训练增强）
                mixed = []
                for i, m in enumerate(legal):
                    mixed.append(max(probs[i], 1e-8) ** 0.1 * max(hs[i], 1e-3) ** 0.9)
                total = sum(mixed)
                probs = np.array([v / total for v in mixed])
            probs = self._policy_with_noise(g, probs, legal)
            idx = {m: i for i, m in enumerate(legal)}
            total = sum(probs[i] for i in range(len(legal)))
            for m in legal:
                p = probs[idx[m]] / total if total > 0 else 1.0 / len(legal)
                node.children[m] = TreeNode(node, p)
            leaf_value = value
        node.update_recursive(leaf_value)

    def get_action_probs(self, game, temp=1e-3):
        """返回 (动作, 概率) 列表，temp 控制采样（训练 temp=1，评估近似贪心）"""
        for _ in range(self.n_playout):
            self.playout(game)
        act_visits = [(a, c.n_visits) for a, c in self.root.children.items()]
        acts, visits = zip(*act_visits) if act_visits else ([], [])
        if temp == 0 or temp < 1e-6:
            probs = np.zeros(len(acts))
            best = np.argmax(visits)
            probs[best] = 1.0
        else:
            logits = np.array(visits, dtype=np.float64) / temp
            exp = np.exp(logits - logits.max())
            probs = exp / exp.sum()
        return list(zip(acts, probs.tolist()))

    def update_with_move(self, move):
        """落子后复用子树（AlphaGo Zero 风格）"""
        if self.root and move in self.root.children:
            self.root = self.root.children[move]
            self.root.parent = None
        else:
            self.root = None

    def reset_root(self, game):
        self.root = TreeNode(None, 1.0)
        self.root_game = game.clone()


def mcts_player(net, game, n_playout=200, temp=1e-3, is_train=False, noise=True):
    """返回可调用的玩家函数 (game) -> move"""
    def policy_value_fn(g):
        state = g.encode_state()
        probs, vals = net.policy_value(state)
        legal = g.legal_moves()
        idx = {m: i for i, m in enumerate(legal)}
        p = np.zeros(len(legal))
        for m in legal:
            p[idx[m]] = probs[0, m[1] * 15 + m[0]]
        return p, vals[0]

    mcts = MCTS(policy_value_fn, n_playout=n_playout, is_train=is_train)

    def choose(g):
        mcts.reset_root(g)
        act_probs = mcts.get_action_probs(g, temp=temp)
        if is_train:
            # 按概率采样
            acts = [a for a, _ in act_probs]
            ps = [p for _, p in act_probs]
            move = acts[np.random.choice(len(acts), p=ps)]
        else:
            move = max(act_probs, key=lambda x: x[1])[0]
        return move

    return choose
