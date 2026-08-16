# -*- coding: utf-8 -*-
"""
策略-价值网络（ResNet）——参考 initial-h/AlphaZero_Gomoku_MPI 的
policy_value_net_tensorlayer.py，改用 PyTorch，规模缩小为 CPU 可训练：
- 输入 8x15x15（4 当前方历史 + 4 对手方历史）
- conv3x3(32) → 4 个残差块(32 filters) → policy head / value head
- 输出：policy(225, logits) + value(1, tanh)
"""
import torch
import torch.nn as nn
import torch.nn.functional as F


class ResBlock(nn.Module):
    def __init__(self, filters):
        super().__init__()
        self.conv1 = nn.Conv2d(filters, filters, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(filters)
        self.conv2 = nn.Conv2d(filters, filters, 3, padding=1, bias=False)
        self.bn2 = nn.BatchNorm2d(filters)

    def forward(self, x):
        out = F.relu(self.bn1(self.conv1(x)))
        out = self.bn2(self.conv2(out))
        return F.relu(out + x)


class PolicyValueNet(nn.Module):
    def __init__(self, board_size=15, in_planes=8, filters=32, res_blocks=4):
        super().__init__()
        self.board_size = board_size
        self.filters = filters
        self.res_blocks = res_blocks
        self.conv1 = nn.Conv2d(in_planes, filters, 3, padding=1, bias=False)
        self.bn1 = nn.BatchNorm2d(filters)
        self.blocks = nn.ModuleList([ResBlock(filters) for _ in range(res_blocks)])
        # policy head
        self.p_conv = nn.Conv2d(filters, 2, 1, bias=False)
        self.p_bn = nn.BatchNorm2d(2)
        self.p_fc = nn.Linear(2 * board_size * board_size, board_size * board_size)
        # value head
        self.v_conv = nn.Conv2d(filters, 1, 1, bias=False)
        self.v_bn = nn.BatchNorm2d(1)
        self.v_fc1 = nn.Linear(board_size * board_size, 256)
        self.v_fc2 = nn.Linear(256, 1)

    def forward(self, x):
        x = F.relu(self.bn1(self.conv1(x)))
        for blk in self.blocks:
            x = blk(x)
        # policy
        p = F.relu(self.p_bn(self.p_conv(x)))
        p = p.view(p.size(0), -1)
        p = self.p_fc(p)  # logits（softmax 在 MCTS 里做）
        # value
        v = F.relu(self.v_bn(self.v_conv(x)))
        v = v.view(v.size(0), -1)
        v = F.relu(self.v_fc1(v))
        v = torch.tanh(self.v_fc2(v))
        return p, v

    def policy_value(self, state_batch):
        """输入 numpy 数组 (N,8,15,15) 或单 (8,15,15)，返回 (probs, values)"""
        if isinstance(state_batch, list):
            x = torch.FloatTensor(state_batch)
        else:
            x = torch.FloatTensor(state_batch)
        if x.dim() == 3:
            x = x.unsqueeze(0)
        self.eval()
        with torch.no_grad():
            p, v = self.forward(x)
            probs = F.softmax(p, dim=1).cpu().numpy()
            vals = v.cpu().numpy().flatten()
        return probs, vals


def create_net(board_size=15, in_planes=8, filters=32, res_blocks=4):
    return PolicyValueNet(board_size, in_planes, filters, res_blocks)
