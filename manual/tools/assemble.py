# -*- coding: utf-8 -*-
"""把 classes.dex 与 assets/ 注入 base.apk 生成 unsigned.apk（纯 zipfile，无外部依赖）。"""
import zipfile, os, shutil

HERE = os.path.dirname(os.path.abspath(__file__))
MAN = os.path.normpath(os.path.join(HERE, '..'))
BASE = os.path.join(MAN, 'out', 'base.apk')
OUT = os.path.join(MAN, 'out', 'unsigned.apk')

with zipfile.ZipFile(BASE, 'r') as zin, zipfile.ZipFile(OUT, 'w', zipfile.ZIP_DEFLATED) as zout:
    for info in zin.infolist():
        zout.writestr(info, zin.read(info.filename))
    # classes.dex 到根
    dex = os.path.join(MAN, 'out', 'dex', 'classes.dex')
    zout.write(dex, 'classes.dex')
    # assets/www 整树
    assets_dir = os.path.join(MAN, 'assets')
    for root, dirs, files in os.walk(assets_dir):
        for fn in files:
            p = os.path.join(root, fn)
            rel = os.path.relpath(p, MAN).replace('\\', '/')
            zout.write(p, rel)
    print('injected classes.dex + assets ->', OUT)
