#!/usr/bin/env bash
# 五子棋 APK 手工构建脚本（零 Gradle 依赖，复用坦克大战管线）
# 管线: aapt2 compile/link -> javac -> d8 -> zip注入dex+assets -> zipalign -> apksigner sign
# 2026-08-22：三层缩放锁定修复版（WebView 原生 + viewport + CSS）
set -euo pipefail

ROOT="/c/Users/XAUTHUB/WorkBuddy/开发/gomoku"
MAN="$ROOT/manual"
SDK="C:/Users/XAUTHUB/Android/Sdk"
BT="$SDK/build-tools/34.0.0"
PLAT="$SDK/platforms/android-34/android.jar"
KEYSTORE="D:/AndroidDev/gomoku-release.keystore"
KSPASS="gomoku2026"
OUT="C:/Users/XAUTHUB/WorkBuddy/开发/gomoku/gomoku-v1.2.9.apk"
PY="C:/Users/XAUTHUB/.workbuddy/binaries/python/versions/3.13.12/python.exe"

export JAVA_HOME='C:\Program Files\Java\jdk-17'
export PATH="/c/Program Files/Java/jdk-17/bin:$PATH"
export ANDROID_HOME="$SDK"

cd "$MAN"
mkdir -p out/gen out/classes out/dex

echo "== [0/7] 同步源资源到打包目录（防旧快照：HUD/样式/JS 必须与源一致）=="
# 2026-08-22 教训：index.html/css 曾停留在 HUD 上线前的旧快照，导致 APK 内
# app.js 访问 $('hud') 崩 TypeError → 「点击进入对局没反应」。此后每次打包
# 强制从源同步，杜绝手工拷贝漂移。
# 【2026-08-22 补充教训】v1.1.5 首包曾漏同步 js/（app.js 停留在 08-50 旧版，
# 不含 GOKUP-004 守卫），只有 index.html/css 同步 → 包内三件套再次不一致。
# 现改为：index.html + css/ + js/ 全量同步 + 内容级 cmp 一致性门禁。
cp "$ROOT/index.html" "$MAN/assets/www/index.html"
cp "$ROOT/css/style.css" "$MAN/assets/www/css/style.css"
cp -r "$ROOT/js/." "$MAN/assets/www/js/"
# PeerJS 本地优先（App 打包增强）：替换 CDN 段为 本地 vendor + CDN 兜底
C:/Users/XAUTHUB/.workbuddy/binaries/python/versions/3.13.12/python.exe - <<'PYEOF'
p = r"C:/Users/XAUTHUB/WorkBuddy/开发/gomoku/manual/assets/www/index.html"
s = open(p, encoding='utf-8').read()
cdns = '''  <!--
    PeerJS 双 CDN fallback：jsdelivr 主，unpkg 备。
    若两个都加载失败（离线），联机模式会提示不可用，人机模式仍可玩。
  -->
  <script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js"></script>
  <script>
    if (typeof Peer === 'undefined') {
      document.write('<script src="https://unpkg.com/peerjs@1.5.5/dist/peerjs.min.js"><\\/script>');
    }
  </script>'''
local = '''  <!--
    PeerJS 本地优先（App 打包增强）：先加载 assets 内置副本，离线可用；
    若本地加载失败（兜底），回退到 jsdelivr CDN。
  -->
  <script src="js/vendor/peerjs.min.js"></script>
  <script>window.Peer || document.write('<script src="https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js"><\\/script>')</script>'''
if cdns in s:
    s = s.replace(cdns, local)
elif 'js/vendor/peerjs.min.js' not in s:
    raise SystemExit('ERROR: 无法识别 index.html 的 PeerJS 段，请人工检查')
open(p, 'w', encoding='utf-8').write(s)
print('  PeerJS 段已确保本地优先')
PYEOF
# 一致性门禁：index.html 必须含 HUD，否则中止打包
grep -q 'id="hud"' "$MAN/assets/www/index.html" || { echo "FATAL: index.html 缺 HUD，中止"; exit 1; }
grep -q 'js/vendor/peerjs.min.js' "$MAN/assets/www/index.html" || { echo "FATAL: index.html 缺本地 PeerJS，中止"; exit 1; }
# 【内容级一致性门禁】无改写的资源必须与源逐字节一致（index.html 因 PeerJS
# 本地化改写属有意差异，走上方 grep 门禁；css/js 必须是源的精确副本）
for f in css/style.css js/app.js; do
  cmp -s "$ROOT/$f" "$MAN/assets/www/$f" || { echo "FATAL: $f 与源不一致（同步失败/漏同步），中止"; exit 1; }
done
echo "  同步校验通过：HUD + 本地 PeerJS + css/app.js 内容一致"

echo "== [1/7] 生成多密度图标（低版本回退）=="
"$PY" tools/gen_gomoku_icon.py

echo "== [1/7] aapt2 compile =="
"$BT/aapt2.exe" compile --dir res -o out/res.zip

echo "== [2/7] aapt2 link =="
"$BT/aapt2.exe" link -o out/base.apk -I "$PLAT" \
  --manifest AndroidManifest.xml --java out/gen out/res.zip

echo "== [3/7] javac =="
# AGP 才会生成 BuildConfig：手工管线补一个 DEBUG=false 的等价 stub（release 语义）
mkdir -p out/gen/com/hawchou/gomoku
cat > out/gen/com/hawchou/gomoku/BuildConfig.java <<'EOF'
package com.hawchou.gomoku;
public final class BuildConfig {
  public static final boolean DEBUG = false;
}
EOF
javac -encoding UTF-8 -source 8 -target 8 -bootclasspath "$PLAT" -d out/classes \
  out/gen/com/hawchou/gomoku/R.java \
  out/gen/com/hawchou/gomoku/BuildConfig.java \
  src/com/hawchou/gomoku/MainActivity.java

echo "== [4/7] d8 -> classes.dex =="
"$BT/d8.bat" --release --lib "$PLAT" --output out/dex \
  out/classes/com/hawchou/gomoku/*.class
ls -la out/dex/

echo "== [5/7] zip 注入 classes.dex + assets =="
"$PY" tools/assemble.py

echo "== [6/7] zipalign =="
"$BT/zipalign.exe" -f 4 out/unsigned.apk out/aligned.apk

echo "== [7/7] apksigner sign =="
"$BT/apksigner.bat" sign \
  --ks "$KEYSTORE" --ks-pass "pass:$KSPASS" --key-pass "pass:$KSPASS" \
  --out "$OUT" out/aligned.apk

echo "== 验证 =="
"$BT/apksigner.bat" verify --print-certs "$OUT"
"$BT/aapt.exe" dump badging "$OUT" | head -6
ls -la "$OUT"
