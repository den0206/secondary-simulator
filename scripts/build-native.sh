#!/bin/sh
# simhid-server（iOS Simulator への HID 直接注入サイドカー）をビルドする。
# macOS 以外では成果物が使えないので黙ってスキップする。拡張は WDA 経由の
# 入力にフォールバックするため、ビルドが無くても動作する。
set -e

if [ "$(uname -s)" != "Darwin" ]; then
  echo "build:native: macOS 以外のためスキップしました（入力は WDA へ降格します）"
  exit 0
fi

# arm64 + x86_64 の universal binary。配布 VSIX は 1 つで両アーキを賄う。
clang -fobjc-arc -O2 \
  -arch arm64 -arch x86_64 \
  -framework Foundation -framework CoreFoundation \
  -framework CoreImage -framework CoreGraphics -framework ImageIO -framework IOSurface \
  -o native/simhid-server native/simhid-server.m

lipo -info native/simhid-server
