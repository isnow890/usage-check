#!/usr/bin/env bash
# Install (or reinstall) the always-on LaunchAgent for this dashboard.
#
# The plist is generated instead of copied so the node path always matches the
# one on this machine. A hardcoded nvm path silently breaks the service the next
# time node is upgraded.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${USAGE_CHECK_LABEL:-com.usage-check.dashboard}"
DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
PORT="${USAGE_CHECK_PORT:-4317}"

NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "node not found on PATH" >&2
  exit 1
fi

if [ ! -d "$ROOT/.next" ]; then
  echo "· building first (no .next found)"
  (cd "$ROOT" && npm run build)
fi

mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"

cat > "$DEST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>

  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/node_modules/next/dist/bin/next</string>
    <string>start</string>
    <string>-p</string>
    <string>$PORT</string>
  </array>

  <key>WorkingDirectory</key>
  <string>$ROOT</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>NODE_ENV</key>
    <string>production</string>
    <key>PATH</key>
    <string>$(dirname "$NODE_BIN"):/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>

  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>

  <key>StandardOutPath</key>
  <string>$HOME/Library/Logs/usage-check.log</string>
  <key>StandardErrorPath</key>
  <string>$HOME/Library/Logs/usage-check.err.log</string>

  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
PLIST

# bootout first so a changed plist is actually re-read. bootstrap immediately
# afterwards can race the teardown and fail with "5: Input/output error", so
# retry once after the job has actually disappeared.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
for attempt in 1 2 3 4 5; do
  if launchctl bootstrap "$DOMAIN" "$DEST" 2>/dev/null; then break; fi
  if [ "$attempt" = "5" ]; then
    echo "could not bootstrap $LABEL" >&2
    exit 1
  fi
  sleep 1
done
launchctl enable "$DOMAIN/$LABEL"

echo "· installed $LABEL"
echo "  node  $NODE_BIN"
echo "  port  $PORT"
launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|properties) ' || true
