#!/bin/bash
# package.sh - Build a clean ZIP for Chrome Web Store submission.
# Usage: bash tools/package.sh   (run from the video2srt/ directory)
# Output: ../video2srt-v<version>.zip (outside the extension dir so it never gets packaged)
# Requires: Windows PowerShell (Compress-Archive); the 'zip' CLI is not needed.

set -e
VERSION=$(node -p "require('./manifest.json').version")
OUTPUT_NAME="video2srt-v${VERSION}.zip"
STAGE=$(mktemp -d)

# Ship only what Chrome needs to run the extension.
# Explicit include list: store docs (CHROMEWEBSTORE.md), tests/ and tools/ stay out.
cp -r manifest.json background.js ui.css content sidepanel options offscreen icons "$STAGE/"

STAGE_WIN=$(cygpath -w "$STAGE")
OUT_WIN=$(cygpath -w "$PWD/../$OUTPUT_NAME")
powershell.exe -NoProfile -Command "Compress-Archive -Path '$STAGE_WIN\\*' -DestinationPath '$OUT_WIN' -Force"

rm -rf "$STAGE"
echo "Packaged: ../$OUTPUT_NAME"
ls -la "../$OUTPUT_NAME"
