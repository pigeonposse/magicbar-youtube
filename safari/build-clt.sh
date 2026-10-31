#!/usr/bin/env bash
# Builds MagicBar.app for Safari using only the Command Line Tools (no Xcode needed).
set -euo pipefail
cd "$(dirname "$0")"

OUT="build/MagicBar for YouTube.app"
APPEX="$OUT/Contents/PlugIns/MagicBar Extension.appex"
rm -rf build
mkdir -p "$OUT/Contents/MacOS" "$APPEX/Contents/MacOS" "$APPEX/Contents/Resources"

cp src/App-Info.plist "$OUT/Contents/Info.plist"
cp src/Ext-Info.plist "$APPEX/Contents/Info.plist"

cp ../magicbar/content.js ../magicbar/background.js manifest.json "$APPEX/Contents/Resources/"
cp -R ../magicbar/icons "$APPEX/Contents/Resources/icons"

swiftc -O src/App.swift -o "$OUT/Contents/MacOS/MagicBar" -framework AppKit -framework SafariServices
swiftc -O -application-extension src/Handler.swift -o "$APPEX/Contents/MacOS/MagicBarExtension" \
  -framework Foundation -framework SafariServices \
  -Xlinker -e -Xlinker _NSExtensionMain

codesign --force --sign - --entitlements src/Ext.entitlements "$APPEX"
codesign --force --sign - --entitlements src/App.entitlements "$OUT"
echo "Built: $PWD/$OUT"
