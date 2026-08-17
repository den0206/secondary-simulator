#!/bin/sh
# インストール済みの Xcode すべてに対して simhid-server --check を回す。
# HID 注入は CoreSimulator / SimulatorKit の私有シンボルに乗っているので、
# Xcode 更新でシンボルやクラス名が消えるとここが落ちる。CI ランナーは
# ユーザーより新しい（ときに beta の）Xcode を持つので、先に踏める。
set -e

[ "$(uname)" = "Darwin" ] || { echo "非 macOS のためスキップ"; exit 0; }
[ -x native/simhid-server ] || { echo "native/simhid-server がない。先に npm run build" >&2; exit 1; }

failed=0
checked=0
for app in /Applications/Xcode*.app; do
  # Xcodes.app（バージョン管理アプリ）などを弾く。simctl があるものだけが Xcode 本体
  [ -x "$app/Contents/Developer/usr/bin/simctl" ] || continue
  checked=$((checked + 1))
  ver="$(/usr/bin/defaults read "$app/Contents/Info" CFBundleShortVersionString 2>/dev/null || echo '?')"
  if DEVELOPER_DIR="$app/Contents/Developer" ./native/simhid-server --check; then
    echo "OK: $app (Xcode $ver)"
  else
    echo "::error::$app (Xcode $ver) で HID 私有 API を解決できない"
    failed=1
  fi
done

if [ "$checked" -eq 0 ]; then
  echo "::error::simctl 付き Xcode が 1 つも見つかりません" >&2
  exit 1
fi

exit "$failed"
