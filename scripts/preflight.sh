#!/bin/bash
# Launch-time pre-flight: fail loudly instead of silently running unverified code.
# See docs/instance-layout.md for the canonical layout this checks.
set -u
R="$HOME/Workspace/dsh-remote-host"
APP="/Applications/DeepSeek Harness.app"
LINK="$HOME/.dsh/profiles/desktop/node_modules/dsh-remote-host"
CLEAN_PATH="/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin"
NODE="/opt/homebrew/bin/node"
[ -x "$NODE" ] || NODE=$(command -v node 2>/dev/null || true)
fail=0
say() { printf "%-46s %s\n" "$1" "$2"; }
# grep -c prints 0 AND exits 1 on no match; without this the count becomes "0 0".
count_of() { local n; n=$(grep -c "$1" "$2" 2>/dev/null) || true; echo "${n:-0}"; }
plugin_git() { env -i HOME="$HOME" PATH="$CLEAN_PATH" git -C "$R" "$@"; }

# ---------------------------------------------------------------- the App itself
[ -d "$APP" ] && say "app bundle" "ok" || { say "app bundle" "MISSING"; fail=1; }
if [ -d "$APP" ]; then
  v=$(/usr/libexec/PlistBuddy -c "Print :CFBundleShortVersionString" "$APP/Contents/Info.plist" 2>/dev/null)
  say "app version" "${v:-unknown}"
  # 'OwnerEntry' exists only in the patched client; the stock app.asar has none of it,
  # so this is the one marker that can tell a patched build from an official one.
  n=$(count_of OwnerEntry "$APP/Contents/Resources/app.asar")
  [ "$n" -gt 0 ] && say "client model patch" "ok ($n refs)" || { say "client model patch" "MISSING (stock build — run scripts/package-app.mjs)"; fail=1; }
fi

total=$(ls -d /Applications/*DeepSeek*Harness*.app 2>/dev/null | wc -l | tr -d " ")
[ "$total" -le 1 ] && say "single app bundle" "ok" || { say "single app bundle" "FOUND $total"; fail=1; }

# ------------------------------------------------------------------ plugin wiring
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

# --------------------------------------------------- the code the remote mount needs
# The client half rewrites the page mux URL to /api/remote.mux by default, so a host that
# does not serve it leaves the remote mount unable to load. Both halves ship together.
n=$(count_of "host mux relay" "$R/lib/index.js")
if [ "$n" -gt 0 ] && [ -f "$R/lib/remote-mux.js" ]; then
  say "host mux relay for session routing" "ok"
else
  say "host mux relay for session routing" "MISSING (mixed local/remote session routing)"
  fail=1
fi

if [ -n "${NODE:-}" ]; then
  if shim_out=$("$NODE" "$R/scripts/build-shim.mjs" --check 2>&1); then
    say "shim build matches sources" "ok"
  else
    say "shim build matches sources" "STALE: $shim_out"
    fail=1
  fi
  # The profile links this repo instead of installing it, so a package manager never
  # installs the plugin's own dependencies: ws has to resolve from the checkout. Without
  # it the host half throws on import and the whole plugin fails to load.
  if ( cd "$R" && "$NODE" --input-type=module -e "import('ws').then(()=>process.exit(0),()=>process.exit(1))" ) >/dev/null 2>&1; then
    say "plugin dependency ws resolves" "ok"
  else
    say "plugin dependency ws resolves" "MISSING (run npm ci in $R)"
    fail=1
  fi
else
  say "node" "MISSING"
  fail=1
fi

# ---------------------------------------------------------------- the live process
# Static files can be right while the running Host predates them. Its own start-up log
# is the only evidence of what this launch actually mounted.
# macOS pgrep -f does not match these long Electron argv lines, so read ps instead.
# The [l] keeps this script's own command line out of the match.
host_pid=$(ps -axo pid=,command= | grep -E "dsh-desktop-host/[l]ib/index\.js" | awk '{print $1}' | head -1)
if [ -n "${host_pid:-}" ]; then
  log="/tmp/dsh-remote-host-$host_pid.log"
  if [ -f "$log" ] && grep -q "host mux relay: ok" "$log"; then
    say "running host mounted the relay" "ok (pid $host_pid)"
  else
    say "running host mounted the relay" "NO MARKER in $log"
    fail=1
  fi
else
  say "running host" "none (start the app first)"
fi

# One ~/.dsh, one host: a launchd 'dsh web' instance shares the session store with the
# desktop App and duplicates every profile operation.
web_n=$(ps -axo command= | grep -E "dsh/[l]ib/bin\.js web" | wc -l | tr -d " ")
[ "$web_n" = "0" ] && say "no second DSH host (dsh web)" "ok" || { say "no second DSH host (dsh web)" "FOUND $web_n"; fail=1; }
# Only *.plist is loaded by launchd; keep .bak copies out of the count.
web_agents=$(ls "$HOME/Library/LaunchAgents/" 2>/dev/null | grep "\.plist$" | grep -c "com\.deepseek\.dsh\.web") || true
[ "${web_agents:-0}" = "0" ] && say "no dsh web autostart" "ok" || { say "dsh web autostart" "FOUND ${web_agents}"; fail=1; }

agents=$(ls "$HOME/Library/LaunchAgents/" 2>/dev/null | grep "\.plist$" | grep -ci "ensure-profile") || true
[ "${agents:-0}" = "0" ] && say "no ensure-profile rewriter" "ok" || { say "ensure-profile rewriter" "FOUND ${agents}"; fail=1; }

# Two desktop instances fight over the single-instance lock and the profile; the loser
# silently drops workspace state. The main process is the one argv line with no flags.
app_n=$(ps -axo command= | grep -cE "^/Applications/DeepSeek Harness\.app/Contents/MacOS/DeepSeek Harness$") || true
[ "${app_n:-0}" -le 1 ] && say "single desktop instance" "ok (${app_n:-0} running)" || { say "single desktop instance" "FOUND ${app_n}"; fail=1; }

if [ "$fail" = "0" ]; then echo "PREFLIGHT OK"; exit 0; else echo "PREFLIGHT FAILED"; exit 1; fi
