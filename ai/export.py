# -*- coding: utf-8 -*-
"""
导出模型为浏览器可用的 JS 全局变量文件（file:// 环境下 fetch 被 CORS 拦截，
用 <script src="model/best_net.js"> 注入 window.GOMOKU_MODEL）。
用法：python ai/export.py
"""
import json
import os

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.path.join(BASE_DIR, "..", "model")


def main():
    src = os.path.join(MODEL_DIR, "best_net.json")
    dst = os.path.join(MODEL_DIR, "best_net.js")
    if not os.path.exists(src):
        print(f"[缺失] {src}（先跑 python ai/train.py 或 ai/learn.py）")
        return
    with open(src, "r", encoding="utf-8") as f:
        data = json.load(f)
    with open(dst, "w", encoding="utf-8") as f:
        f.write("window.GOMOKU_MODEL = ")
        json.dump(data, f, separators=(",", ":"))
        f.write(";\n")
    print(f"[导出] {dst}（{os.path.getsize(dst) // 1024} KB）—— index.html 已自动引入")


if __name__ == "__main__":
    main()
