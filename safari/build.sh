#!/usr/bin/env bash
# Builds the Safari version of MagicBar from the shared sources in ../magicbar.
# Requires macOS with Xcode (not just the Command Line Tools).
set -euo pipefail

cd "$(dirname "$0")"

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "safari-web-extension-converter not found. Install Xcode and run:" >&2
  echo "  sudo xcode-select -s /Applications/Xcode.app/Contents/Developer" >&2
  exit 1
fi

rm -rf extension project
mkdir -p extension
cp ../magicbar/content.js ../magicbar/background.js extension/
cp -R ../magicbar/icons extension/icons
cp manifest.json extension/manifest.json

xcrun safari-web-extension-converter extension \
  --project-location project \
  --app-name "MagicBar for YouTube" \
  --bundle-identifier com.pigeonposse.magicbar \
  --swift --macos-only --copy-resources --no-open --force

echo
echo "Done. Open project/MagicBar for YouTube/MagicBar for YouTube.xcodeproj, press Run,"
echo "then enable the extension in Safari > Settings > Extensions."
