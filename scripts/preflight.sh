#!/bin/bash
# Launch-time pre-flight: fail loudly instead of silently running unverified code.
# See docs/instance-layout.md for the canonical layout this checks.
set -u
R="$HOME/Workspace/dsh-remote-host"
APP="/Applications/DeepSeek Harness.app"
LINK="$HOME/.dsh/profiles/desktop/node_modules/dsh-remote-host"
CLEAN_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
fail=0
say() { printf "%-46s %s\n" "$1" "$2"; }
# grep -c prints 0 AND exits 1 on no match; without this the count becomes "0 0".
count_of() { local n; n=$(grep -c "$1" "$2" 2>/dev/null) || true; echo "${n:-0}"; }
plugin_git() { env -i HOME="$HOME" PATH="$CLEAN_PATH" git -C "$R" "$@"; }

[ -d "$APP" ] && say "app bundle" "ok" || { say "app bundle" "MISSING"; fail=1; }
if [ -d "$APP" ]; then
  v=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null)
  say "app version" "${v:-unknown}"
  n=$(count_of storeFor "$APP/Contents/Resources/app.asar")
  [ "$n" -gt 0 ] && say "client model patch" "ok ($n refs)" || { say "client model patch" "MISSING"; fail=1; }
fi

total=$(ls -d /Applications/*DeepSeek*Harness*.app 2>/dev/null | wc -l | tr -d " ")
[ "$total" -le 1 ] && say "single app bundle" "ok" || { say "single app bundle" "FOUND $total"; fail=1; }

target=$(readlink -f "$LINK" 2>/dev/null || echo "")
[ "$target" = "$R" ] && say "plugin symlink" "ok" || { say "plugin symlink" "points to ${target:-nothing}"; fail=1; }

main_rev=$(plugin_git rev-parse --verify main 2>/dev/null || echo none)
origin_rev=$(plugin_git rev-parse --verify origin/main 2>/dev/null || echo none)
[ "$main_rev" = "$origin_rev" ] && [ "$main_rev" != "none" ] && say "main == origin/main" "ok" || { say "main == origin/main" "$main_rev vs $origin_rev"; fail=1; }
if plugin_git merge-base --is-ancestor "$origin_rev" HEAD 2>/dev/null; then
  say "running checkout includes origin/main" "ok"
else
  say "running checkout includes origin/main" "MISSING"
  fail=1
fi

n=$(count_of "host mux relay" "$R/lib/index.js")
if [ "$n" -gt 0 ] && [ -f "$R/lib/remote-mux.js" ]; then
  say "host mux relay for session routing" "ok"
else
  say "host mux relay for session routing" "MISSING (mixed local/remote session routing)"
  fail=1
fi

agents=$(ls "$HOME/Library/LaunchAgents/" 2>/dev/null | grep -ci "ensure-profile") || true
[ "${agents:-0}" = "0" ] && say "no ensure-profile rewriter" "ok" || { say "ensure-profile rewriter" "FOUND ${agents}"; fail=1; }

if [ "$fail" = "0" ]; then echo "PREFLIGHT OK"; exit 0; else echo "PREFLIGHT FAILED"; exit 1; fi
