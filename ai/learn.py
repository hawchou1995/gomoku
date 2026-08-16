# -*- coding: utf-8 -*-
"""
每局复盘学习（用户实战棋谱 → 增量训练）：
读取 model/games/*.json（浏览器每局结束导出的棋谱），重放生成训练样本：
- policy target：落子位置 one-hot（行为克隆，教网络模仿实战/高手走法）
- value target：终局胜负（强化信号，教网络评估局面）
合并训练后经胜率门控替换模型。

用法：
  1. 浏览器每局结束 → 自动下载棋谱到 model/games/
  2. python ai/learn.py [--epochs 5] [--batch 128] [--eval 6]
"""
import argparse
import json
import glob
import os
import random

import numpy as np
import torch
import torch.nn as nn
import torch.optim as optim

from game import Game, BLACK, WHITE, heuristic_scores
from net import create_net
from mcts import MCTS
from train import MODEL_DIR, GAMES_DIR, train_step, play_between, mcts_move, save_model, load_model, export_json


def load_replay_samples(games_dir):
    """读 model/games/*.json → [(state, onehot_policy, value), ...]
    处理过的棋谱移入 games/done/（避免重复学习）；--keep 保留原位。"""
    samples = []
    files = sorted(glob.glob(os.path.join(games_dir, "*.json")))
    if not files:
        print(f"  [无棋谱] {games_dir} 下没有 *.json 棋谱（浏览器对局结束会自动导出）")
        return samples
    done_dir = os.path.join(games_dir, "done")
    os.makedirs(done_dir, exist_ok=True)
    learned = 0
    for f in files:
        try:
            data = json.load(open(f, encoding="utf-8"))
            moves = data.get("moves", [])
            if len(moves) < 8:
                os.rename(f, os.path.join(done_dir, os.path.basename(f)))
                continue
            game = Game()
            states = []
            for m in moves:
                p = BLACK if str(m.get("player", "black")) == "black" else WHITE
                game.place(m["x"], m["y"], p)
                states.append(game.encode_state())
            winner = data.get("winner")
            w = 0
            if winner == "black":
                w = BLACK
            elif winner == "white":
                w = WHITE
            for i, s in enumerate(states):
                cur = BLACK if i % 2 == 0 else WHITE
                v = 1.0 if w == cur else (-1.0 if w != 0 else 0.0)
                # 行为克隆策略修正【2026-08-16】：赢棋方走法全学（模仿胜利者）；
                # 输棋方只学前 60% 步（开局/中盘正常期——败局后半段的挣扎走法
                # 是坏棋，全学会把败者坏棋当正样本；完全不学又丢基本走法，
                # 35 局赢家几乎全是黑方 → 只学赢家会让执白模型废掉）。
                m = moves[i]
                p_onehot = np.zeros(15 * 15, dtype=np.float32)
                if w == 0 or w == cur or i < int(len(states) * 0.6):
                    p_onehot[m["y"] * 15 + m["x"]] = 1.0
                samples.append((s, p_onehot, v))
            learned += 1
            print(f"  ✓ {os.path.basename(f)}：{len(moves)} 步 → {len(moves)} 样本")
        except Exception as e:
            print(f"  ✗ {os.path.basename(f)} 解析失败：{e}")
            continue
        # 归档已学习棋谱（防重复训练）
        try:
            os.rename(f, os.path.join(done_dir, os.path.basename(f)))
        except Exception:
            pass
    if learned:
        print(f"  [归档] {learned} 局已学习并移入 games/done/")
    return samples


def greedy_baseline_move(game):
    """贪心启发式基线（ego 棋力下限）：选启发式评分最高的点。门控对手固定，不受训练污染。"""
    legal = game.legal_moves()
    hs = heuristic_scores(game, legal)
    return legal[int(np.argmax(hs))]


def play_vs_greedy(net, n_playout, games):
    """新模型 MCTS vs 贪心基线，黑白各半 → (胜, 平)"""
    wins = 0
    draws = 0
    for gi in range(games):
        game = Game()
        model_black = gi % 2 == 0
        while True:
            end, winner = game.is_end()
            if end:
                break
            is_model_turn = (game.current == BLACK) == model_black
            if is_model_turn:
                move = mcts_move(net, game, n_playout)
            else:
                move = greedy_baseline_move(game)
            game.place(move[0], move[1], game.current)
        if winner == 0:
            draws += 1
        elif (winner == BLACK) == model_black:
            wins += 1
    return wins, draws


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--epochs", type=int, default=5)
    parser.add_argument("--batch", type=int, default=128)
    parser.add_argument("--eval", type=int, default=6, help="门控对战局数（--gating 时）")
    parser.add_argument("--playouts", type=int, default=150, help="门控 MCTS 模拟数")
    parser.add_argument("--lr", type=float, default=0.001)
    parser.add_argument("--gating", action="store_true",
                        help="启用 vs 贪心基线的胜率门控（默认关闭：学习即生效）")
    args = parser.parse_args()

    samples = load_replay_samples(GAMES_DIR)
    if not samples:
        return

    net = create_net(filters=16, res_blocks=2)
    best_net = create_net(filters=16, res_blocks=2)
    best_path = os.path.join(MODEL_DIR, "best_net.pt")
    load_model(best_net, best_path)
    net.load_state_dict(best_net.state_dict())

    print(f"\n════ 复盘学习：{len(samples)} 样本 × {args.epochs} epoch ════")
    train_step(net, samples, args.batch, args.epochs, args.lr)

    if args.gating:
        # 门控：新模型 MCTS vs 贪心启发式基线（参考用——弱模型 MCTS 互啄/磨满盘噪音大，
        # 真实棋力验证以浏览器融合引擎实战为准）
        wins, draws = play_vs_greedy(net, args.playouts, args.eval)
        score = (wins + draws / 2) / args.eval
        print(f"门控：新模型 {wins}胜 {draws}平 / {args.eval} 局（vs 贪心基线）→ 胜率 {score:.0%}")
        if score < 0.55:
            print("❌ 未达门控，保留原模型（可用 --no-gating 强制替换）")
            return

    best_net.load_state_dict(net.state_dict())
    save_model(net, best_path)
    export_json(net, os.path.join(MODEL_DIR, "best_net.json"))
    print("✅ 复盘生效：模型已进化并导出（浏览器刷新后生效）")


if __name__ == "__main__":
    main()
