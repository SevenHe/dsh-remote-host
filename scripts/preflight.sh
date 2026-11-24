#!/bin/bash
# Launch-time pre-flight: fail loudly instead of silently running unverified code.
set -u
R=/Users/bytedance/Workspace/dsh-remote-host
APP="/Applications/DeepSeek Harness.app"
LINK="$HOME/.dsh/profiles/desktop/node_modules/dsh-remote-host"
GIT="env -i HOME=$HOME PATH=/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin git"
fail=0
say() { printf "%-46s %s\n" "$1" "$2"; }

[ -d "$APP" ] && say "app bundle" "ok" || { say "app bundle" "MISSING"; fail=1; }
if [ -d "$APP" ]; then
  v=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null)
  say "app version" "${v:-unknown}"
  n=$(LC_ALL=C grep -ac storeFor "$APP/Contents/Resources/app.asar" 2>/dev/null || echo 0)
  [ "$n" -gt 0 ] && say "client model patch" "ok ($n refs)" || { say "client model patch" "MISSING"; fail=1; }
fi

total=$(ls -d /Applications/*DeepSeek*Harness*.app 2>/dev/null | wc -l | tr -d " ")
[ "$total" -le 1 ] && say "single app bundle" "ok" || { say "single app bundle" "FOUND $total"; fail=1; }

target=$(readlink -f "$LINK" 2>/dev/null || echo "")
[ "$target" = "$R" ] && say "plugin symlink" "ok" || { say "plugin symlink" "points to ${target:-nothing}"; fail=1; }

local=$($GIT -C "$R" rev-parse main 2>/dev/null || echo none)
remote=$($GIT -C "$R" rev-parse origin/main 2>/dev/null || echo none)
[ "$local" = "$remote" ] && [ "$local" != "none" ] && say "main == origin/main" "ok" || { say "main == origin/main" "$local vs $remote"; fail=1; }

n=$(grep -c "host mux relay" "$R/lib/index.js" 2>/dev/null || echo 0)
[ "$n" = "0" ] && say "no experimental relay" "ok" || { say "no experimental relay" "FOUND"; fail=1; }

agents=$(ls ~/Library/LaunchAgents/ 2>/dev/null | grep -ci "ensure-profile" || true)
[ "$agents" = "0" ] && say "no ensure-profile rewriter" "ok" || { say "ensure-profile rewriter" "FOUND $agents"; fail=1; }

if [ "$fail" = "0" ]; then echo "PREFLIGHT OK"; exit 0; else echo "PREFLIGHT FAILED"; exit 1; fi