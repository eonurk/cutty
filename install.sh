#!/bin/bash
# Installs the Cutty CEP panel for Adobe Premiere Pro (macOS).
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
EXT_ID="com.onur.cutty"
DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/$EXT_ID"
LEGACY_DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.onur.silencecutter"

mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST" "$LEGACY_DEST"
mkdir -p "$DEST"
cp -R "$SRC/CSXS" "$SRC/js" "$SRC/jsx" "$SRC/index.html" "$SRC/.debug" "$DEST/"

# Allow unsigned (development) CEP extensions — the standard CEP dev flag.
# Revert any of these with: defaults delete com.adobe.CSXS.<n> PlayerDebugMode
for v in 9 10 11 12; do
  defaults write "com.adobe.CSXS.$v" PlayerDebugMode 1
done
killall cfprefsd 2>/dev/null || true

echo "Installed to: $DEST"
echo "Restart Premiere Pro, then open: Window > Extensions > Cutty"
