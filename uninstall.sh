#!/bin/bash
# Removes the Cutty CEP panel and its legacy Silence Cutter installation.
set -euo pipefail

DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.onur.cutty"
LEGACY_DEST="$HOME/Library/Application Support/Adobe/CEP/extensions/com.onur.silencecutter"
rm -rf "$DEST" "$LEGACY_DEST"
echo "Removed Cutty."

read -r -p "Also disable unsigned CEP extensions (PlayerDebugMode)? Skip if you use other dev panels. [y/N] " ans
if [[ "${ans:-n}" =~ ^[Yy]$ ]]; then
  for v in 9 10 11 12; do
    defaults delete "com.adobe.CSXS.$v" PlayerDebugMode 2>/dev/null || true
  done
  killall cfprefsd 2>/dev/null || true
  echo "PlayerDebugMode disabled."
fi
