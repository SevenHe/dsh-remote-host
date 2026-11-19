#!/bin/bash
# Isolated lab profile: copy of the desktop profile on its own port, so a plugin
# change can be exercised without touching the live app.
set -u
ROOT=${1:-/tmp/dsh-rh-block}
PORT=${2:-19949}
APP="/Applications/DeepSeek Harness.app"
BIN="$APP/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js"
pkill -f "profile blocklab" 2>/dev/null; sleep 1
rm -rf "$ROOT"; mkdir -p "$ROOT/profiles/blocklab"
cp ~/.dsh/profiles/desktop/package.json "$ROOT/profiles/blocklab/package.json"
cp ~/.dsh/profiles/desktop/cordis.patch.yml "$ROOT/profiles/blocklab/cordis.patch.yml"
ln -sfn ~/.dsh/profiles/desktop/node_modules "$ROOT/profiles/blocklab/node_modules"
cp ~/.dsh/.credentials.yaml "$ROOT/.credentials.yaml"; chmod 600 "$ROOT/.credentials.yaml"
cp -R ~/.dsh/storages "$ROOT/storages" 2>/dev/null || true
cp -R ~/.dsh/sessions "$ROOT/sessions" 2>/dev/null || true
DSH_HOME=$ROOT nohup env ELECTRON_RUN_AS_NODE=1 "$APP/Contents/MacOS/DeepSeek Harness" "$BIN" --profile blocklab --port "$PORT" --no-open > "$ROOT/boot.log" 2>&1 &
sleep 18
grep -E "dsh web:" "$ROOT/boot.log" | head -1
