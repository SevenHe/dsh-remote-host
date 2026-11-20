#!/bin/bash
# Launch the desktop app with renderer logging enabled, so the V8 fatal message
# ("# Fatal error ... Check failed: ...") lands in a file instead of vanishing.
# The packaged app discards renderer stderr, which is why the .ips and the app's
# own crash-*.log never contain it.
set -u
APP='/Applications/DeepSeek Harness.app'
BIN="$APP/Contents/MacOS/DeepSeek Harness"
LOG="${1:-/tmp/dsh-app-debug.log}"
if [ ! -x "$BIN" ]; then echo "app not found: $BIN"; exit 1; fi
echo "stopping any running instance..."
pkill -f "DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" 2>/dev/null || true
sleep 2
: > "$LOG"
echo "launching with ELECTRON_ENABLE_LOGGING=1 -> $LOG"
ELECTRON_ENABLE_LOGGING=1 \
ELECTRON_ENABLE_STACK_DUMPING=1 \
  nohup "$BIN" --enable-logging=stderr --v=0 >> "$LOG" 2>&1 &
sleep 8
echo "--- log so far ($(wc -l < "$LOG") lines) ---"
tail -5 "$LOG" 2>/dev/null
echo
echo "reproduce the crash, then run:"
echo "  grep -nE 'Fatal error|Check failed|# Fatal|Received signal|SIGTRAP|v8::internal' $LOG | tail -40"
