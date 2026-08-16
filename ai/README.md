# AlphaZero 自学习进化系统（融合引擎）

融合 **ego**（tangyan02/ego：博弈树 + 棋形评估，QQ 九段）的棋力
与 **AlphaZero_Gomoku_MPI**（initial-h：ResNet + MCTS + 自对弈）的自学习进化。

## 架构（单一融合引擎）

**核心原则：一个 AI，一个决策管线。** 自学习模型不改变决策管线，
而是以"候选池融合"接入——保证 ego 级棋力的同时获得自学习能力。

```
getBestMove(board, player, level, deadline, forbid, history)
  1. 威胁决策层（my-win > op-win > my-force > op-force）→ 直出   ← ego 棋力
  2. findVcfStarts / VCT 强制链 / 多威胁裁决 / 预防层 / 两步威胁 → 直出 ← ego 棋力
  3. 无强制威胁 → 深度搜索（depth 6）
       候选池 = 启发式候选(前 maxCand-6) ∪ AlphaZero 网络 policy top-6  ← 自学习
       （网络推荐进入搜索视野，模型进化后逐渐影响选点；只增不减，棋力不退化）
```

- **保证棋力**：威胁层/VCT/搜索全部保留（棋谱 19/20/21 关键点验证通过），
  网络缺失时引擎行为与原九段完全一致
- **自学习**：网络（ResNet 4 块 32f，8 平面特征）经 train.py 自对弈 /
  learn.py 实战复盘进化，进化后的 policy 影响候选池 → 棋力渐进提升
- 对弈验证：融合 vs 原九段 8 局 62.5% / 37.5%（黑白各半），不退化

## 浏览器/训练端

```
浏览器（对局/推理）                    Python（训练/进化）
┌─────────────────────────┐           ┌──────────────────────────┐
│ index.html（单一引擎，无选择）│           │ ai/game.py  规则+特征编码   │
│ js/ai.js  威胁层+VCT+搜索  │           │ ai/net.py   ResNet(4块32f)  │
│   └ _useNet(nf) 候选融合   │           │ ai/mcts.py  UCT+Dirichlet  │
│ js/net_forward.js 前向     │ ──模型──▶ │ ai/train.py 自对弈+训练+门控 │
│ model/best_net.js 全局注入 │◀── JSON ──│ ai/learn.py 复盘学习(实战)  │
│ model/games/*.json 棋谱   │ ──棋谱──▶ │ ai/export.py → JSON/JS     │
└─────────────────────────┘           └──────────────────────────┘
```

## 关键设计（对应两个参考项目）

| 组件 | 来源 | 说明 |
|---|---|---|
| 威胁决策层/VCT/搜索 | ego | 决策管线全部保留（my-win→op-win→force→VCT→多威胁→深度搜索），棋力保底 |
| 候选池融合 | 新增 | 搜索候选 = 启发式前 24 + 网络 policy top-6（只增不减），自学习影响选点 |
| 特征编码 | AlphaZero | 8 平面（4 当前方历史 + 4 对手方历史），与训练端一致 |
| 网络 | AlphaZero | ResNet：conv3x3(32) + 4 残差块 + policy/value 双头 |
| 训练 | AlphaZero | 自对弈 buffer 采样，Adam lr=0.001，loss = 交叉熵(policy) + MSE(value) |
| 进化门控 | AlphaZero | 新模型 vs 当前最优对战 ≥55% 胜率才替换，否则回滚 |
| 复盘学习 | 新增 | 实战棋谱 one-hot 行为克隆 + 胜负强化，增量训练 |

## 使用方法（全自动闭环）

### 零操作模式（推荐）
```bash
node ai/auto_learn.js        # 常驻守护：检测到新棋谱自动训练 + 导出模型
```
1. 浏览器正常对局 → 每局结束自动下载棋谱到下载目录
2. 守护进程自动检测（3s 轮询）→ 复制到 `model/games/` → 空闲 30s 后自动跑 learn.py
3. 学习完成自动导出 `best_net.js` → **刷新浏览器即用新模型**

### 手动模式
```bash
python ai/learn.py           # 复盘学习（读 model/games/，学完归档到 games/done/）
python ai/train.py          # 完整自对弈训练
python ai/export.py         # 导出浏览器模型
```

### 浏览器使用
- 首页人机对战 → 引擎栏显示「融合引擎（启发式 + 自学习）」与模型状态
- 模型已加载时显示「自学习模型已加载 ✓」；模型缺失引擎行为与原九段完全一致

## 文件清单

| 文件 | 职责 |
|---|---|
| ai/game.py | 规则（与 engine.js 对齐）+ 8 平面特征编码 + 启发式评分 |
| ai/net.py | ResNet 策略-价值网络（PyTorch） |
| ai/mcts.py | MCTS（UCT + Dirichlet + 启发式先验混合） |
| ai/train.py | 自对弈 → 训练 → 门控 → 导出 |
| ai/learn.py | 实战棋谱复盘学习 |
| ai/export.py | 权重导出 JSON / JS |
| js/net_forward.js | JS 手写前向推理（与 PyTorch 数值一致，误差 <1e-6） |
| js/ai_mcts.js | 浏览器 MCTS + 特征编码 + 启发式注入 |
| model/best_net.pt | Python 训练源模型 |
| model/best_net.json / best_net.js | 浏览器推理模型 |
| model/games/ | 复盘学习棋谱目录 |

## 已知限制 / 后续
- 当前网络 4 块 32 滤波（CPU 可训）；增大 filters/blocks 提升上限（训练变慢）
- JS MCTS 未实现树复用（每步重建）与根节点噪声——纯 AlphaZero 探索略欠，启发式先验已补偿
- 自对弈样本质量依赖启发式先验权重（0.9）——网络增强后可调高 policy 权重
- 禁手规则未纳入训练（与 AlphaZero_Gomoku_MPI 一致）；实战禁手由 JS 侧 engine 拦截
