# -*- coding: utf-8 -*-
"""
AlphaZero 自学习训练主循环——参考 initial-h/AlphaZero_Gomoku_MPI 的 train.py：
1. 自对弈：MCTS（temp=1 采样 + Dirichlet 噪声）自我对弈，收集 (state, probs, winner)
2. 训练：从 buffer 采样 batch 训练策略-价值网络（Adam lr=0.001，交叉熵 + MSE）
3. 进化门控：新模型 vs 当前最优对战 N 局，胜率 >=55% 才替换（AlphaZero 评估机制）
4. 导出：best 权重 → model/best_net.json（JS 前向推理用）

用法：
  python ai/train.py --games 20 --playouts 100 --epochs 5 --eval 10
"""
import argparse
import json
import os
import random
import time

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from game import Game, BLACK, WHITE, heuristic_scores
from net import create_net
from mcts import MCTS

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "..", "model")
GAMES_DIR = os.path.join(MODEL_DIR, "games")


def self_play_one_game(net, n_playout, temp, buffer, max_games):
    """一局自对弈：返回样本列表 [(state, probs, winner_view)]"""
    def policy_value_fn(g):
        state = g.encode_state()
        probs, vals = net.policy_value(state)
        legal = g.legal_moves()
        p = np.zeros(len(legal))
        for i, m in enumerate(legal):
            p[i] = probs[0, m[1] * 15 + m[0]]
        return p, vals[0]

    mcts = MCTS(policy_value_fn, n_playout=n_playout, is_train=True, heuristic_fn=heuristic_scores)
    game = Game()
    samples = []
    while True:
        mcts.reset_root(game)
        act_probs = mcts.get_action_probs(game, temp=1.0)
        state = game.encode_state()
        # 映射到固定 225 维（非法点=0），训练时按棋盘位置取概率
        full_probs = np.zeros(15 * 15, dtype=np.float32)
        for m, p in act_probs:
            full_probs[m[1] * 15 + m[0]] = p
        samples.append((state, full_probs))
        acts = [a for a, _ in act_probs]
        ps = [p for _, p in act_probs]
        move = acts[np.random.choice(len(acts), p=ps)]
        game.place(move[0], move[1], game.current)
        mcts.update_with_move(move)
        end, winner = game.is_end()
        if end:
            break
    # 换算 winner 视角
    for i, (s, p) in enumerate(samples):
        if winner == 0:
            v = 0.0
        else:
            # 第 i 步时轮到谁（黑=1 白=-1），winner 视角
            cur = BLACK if i % 2 == 0 else WHITE
            v = 1.0 if winner == cur else -1.0
        buffer.append((s, p, v))
    return winner


def train_step(net, buffer, batch_size, epochs, lr):
    optimizer = optim.Adam(net.parameters(), lr=lr)
    states = torch.FloatTensor(np.stack([b[0] for b in buffer]))
    probs = torch.FloatTensor(np.stack([b[1] for b in buffer]))
    values = torch.FloatTensor([b[2] for b in buffer])
    n = len(buffer)
    net.train()
    for epoch in range(epochs):
        idx = np.random.permutation(n)
        total_loss = 0.0
        for start in range(0, n, batch_size):
            batch = idx[start:start + batch_size]
            x = states[batch]
            p_target = probs[batch]
            v_target = values[batch]
            p_logits, v_pred = net(x)
            loss_p = -torch.mean(torch.sum(p_target * torch.log_softmax(p_logits, dim=1), dim=1))
            loss_v = torch.mean((v_pred.squeeze() - v_target) ** 2)
            loss = loss_p + loss_v
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            total_loss += loss.item()
        print(f"  epoch {epoch + 1}: loss={total_loss / max(1, n // batch_size):.4f}")


def play_between(net_a, net_b, n_playout, games):
    """net_a vs net_b 对战（net_b=None 时 vs 随机走子基线）"""
    wins_a = 0
    draws = 0
    for gi in range(games):
        game = Game()
        # 交替先后手
        first = net_a if gi % 2 == 0 else net_b
        second = net_b if gi % 2 == 0 else net_a
        cur = first
        while True:
            end, winner = game.is_end()
            if end:
                break
            if cur is None:
                # 随机基线
                legal = game.legal_moves()
                move = random.choice(legal)
            else:
                move = mcts_move(cur, game, n_playout)
            game.place(move[0], move[1], game.current)
            cur = second if cur is first else first
        if winner == 0:
            draws += 1
        elif winner == BLACK:
            wins_a += 1 if gi % 2 == 0 else 0
        else:
            wins_a += 0 if gi % 2 == 0 else 1
    return wins_a, draws


def mcts_move(net, game, n_playout):
    def policy_value_fn(g):
        state = g.encode_state()
        probs, vals = net.policy_value(state)
        legal = g.legal_moves()
        p = np.zeros(len(legal))
        for i, m in enumerate(legal):
            p[i] = probs[0, m[1] * 15 + m[0]]
        return p, vals[0]
    mcts = MCTS(policy_value_fn, n_playout=n_playout, is_train=False, heuristic_fn=heuristic_scores)
    mcts.reset_root(game)
    act_probs = mcts.get_action_probs(game, temp=0)
    return max(act_probs, key=lambda x: x[1])[0]


def save_model(net, path):
    torch.save(net.state_dict(), path)


def load_model(net, path):
    net.load_state_dict(torch.load(path, map_location="cpu"))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--games", type=int, default=20, help="每轮自对弈局数")
    parser.add_argument("--playouts", type=int, default=100, help="MCTS 模拟次数")
    parser.add_argument("--epochs", type=int, default=5, help="每轮训练 epoch")
    parser.add_argument("--batch", type=int, default=256)
    parser.add_argument("--buffer", type=int, default=5000, help="经验池容量")
    parser.add_argument("--eval", type=int, default=10, help="门控对战局数")
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--rounds", type=int, default=10, help="训练轮数")
    parser.add_argument("--filters", type=int, default=32)
    parser.add_argument("--blocks", type=int, default=4)
    args = parser.parse_args()

    os.makedirs(MODEL_DIR, exist_ok=True)
    os.makedirs(GAMES_DIR, exist_ok=True)

    net = create_net(filters=args.filters, res_blocks=args.blocks)
    best_path = os.path.join(MODEL_DIR, "best_net.pt")
    best_net = create_net(filters=args.filters, res_blocks=args.blocks)
    if os.path.exists(best_path):
        load_model(best_net, best_path)
        net.load_state_dict(best_net.state_dict())
        print(f"[加载] 已有模型 {best_path}")
    else:
        save_model(net, best_path)
        print("[初始化] 新模型已保存")

    buffer = []
    for rnd in range(1, args.rounds + 1):
        t0 = time.time()
        print(f"\n════ 第 {rnd} 轮自对弈（{args.games} 局 × {args.playouts} playouts）════")
        for gi in range(args.games):
            winner = self_play_one_game(net, args.playouts, 1.0, buffer, args.games)
            if len(buffer) > args.buffer:
                buffer = buffer[-args.buffer:]
            tag = {0: "平", BLACK: "黑胜", WHITE: "白胜"}[winner]
            print(f"  局 {gi + 1}/{args.games}：{tag}（样本 {len(buffer)}）")
        print(f"  自对弈耗时 {time.time() - t0:.0f}s，训练中…")
        train_step(net, buffer, args.batch, args.epochs, args.lr)

        # 门控评估：新模型 vs 当前最优
        wins, draws = play_between(net, best_net, args.playouts, args.eval)
        score = (wins + draws / 2) / args.eval
        print(f"  门控：新模型 {wins}胜 {draws}平 / {args.eval} 局（含黑白各半）→ 胜率 {score:.0%}")
        if score >= 0.55:
            best_net.load_state_dict(net.state_dict())  # 同步权重（否则 pt 与 json 导出不一致）
            save_model(net, best_path)
            print("  ✅ 胜率 ≥55%，替换最优模型")
        else:
            net.load_state_dict(best_net.state_dict())
            print("  ❌ 未达门控，回滚至最优模型")

    # 导出 JSON 供 JS 前向推理
    export_json(best_net, os.path.join(MODEL_DIR, "best_net.json"))
    print(f"\n完成。最优模型 → model/best_net.pt / model/best_net.json")


def export_json(net, path):
    """导出权重为 JSON（JS 手写前向推理用）"""
    sd = net.state_dict()
    out = {
        "board_size": 15,
        "in_planes": 8,
        "filters": net.filters,
        "res_blocks": net.res_blocks,
        "weights": {},
    }
    for k, v in sd.items():
        out["weights"][k] = v.cpu().numpy().tolist()
    with open(path, "w") as f:
        json.dump(out, f)
    print(f"[导出] {path}（{os.path.getsize(path) // 1024} KB）")


if __name__ == "__main__":
    main()
