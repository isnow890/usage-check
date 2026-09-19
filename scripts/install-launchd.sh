#!/usr/bin/env bash
# Install (or reinstall) the always-on LaunchAgent for this dashboard.
#
# The plist is generated instead of copied so the node path always matches the
# one on this machine. A hardcoded nvm path silently breaks the service the next
# time node is upgraded.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/install-launchd.sh [options]

With no options the dashboard listens on every interface, so a phone on the
same Wi-Fi can open http://<machine-name>:4317 with nothing else installed.

  --tailscale    Listen on 127.0.0.1 only and publish it to your tailnet with
                 `tailscale serve`. Nothing on the local network can reach it.
  --bind HOST    Bind one explicit address instead (default 0.0.0.0).
  --port PORT    Port to listen on (default 4317).
  --label NAME   LaunchAgent label (default com.usage-check.dashboard).
  -h, --help     Show this.

USAGE_CHECK_BIND, USAGE_CHECK_PORT and USAGE_CHECK_LABEL set the same values
and are overridden by the flags above.
EOF
}

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="${USAGE_CHECK_LABEL:-com.usage-check.dashboard}"
PORT="${USAGE_CHECK_PORT:-4317}"
BIND_HOST="${USAGE_CHECK_BIND:-0.0.0.0}"
TAILSCALE=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --tailscale) TAILSCALE=1; BIND_HOST="127.0.0.1"; shift ;;
    --bind) BIND_HOST="${2:?--bind needs a host}"; shift 2 ;;
    --port) PORT="${2:?--port needs a number}"; shift 2 ;;
    --label) LABEL="${2:?--label needs a name}"; shift 2 ;;
    -h | --help) usage; exit 0 ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

DEST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"

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
    <string>-H</string>
    <string>$BIND_HOST</string>
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
# afterwards races the teardown and fails with "5: Input/output error", so give
# the old job a moment and keep retrying until it is really gone.
launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
sleep 1
for attempt in 1 2 3 4 5 6 7 8; do
  if launchctl bootstrap "$DOMAIN" "$DEST" 2>/dev/null; then break; fi
  if [ "$attempt" = "8" ]; then
    echo "could not bootstrap $LABEL" >&2
    exit 1
  fi
  sleep 1
done
launchctl enable "$DOMAIN/$LABEL"

echo "· installed $LABEL"
echo "  node  $NODE_BIN"
echo "  bind  $BIND_HOST:$PORT"
launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -E '^\s+(state|pid|properties) ' || true

# `tailscale serve` blocks when the tailnet has not enabled Serve yet, which
# would hang the installer, so wait for it in the background instead.
publish_to_tailnet() {
  if ! command -v tailscale >/dev/null 2>&1; then
    echo "· tailscale not found — the service is loopback-only, so nothing can reach it yet" >&2
    echo "  install Tailscale, then run: tailscale serve --bg $PORT" >&2
    return 0
  fi

  local log pid attempt
  log="$(mktemp)"
  tailscale serve --bg "$PORT" >"$log" 2>&1 &
  pid=$!

  for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if tailscale serve status 2>/dev/null | grep -q "127.0.0.1:$PORT"; then
      kill "$pid" 2>/dev/null || true
      echo "· published to the tailnet"
      tailscale serve status 2>/dev/null | head -1 | sed 's/^/  /'
      return 0
    fi
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done

  kill "$pid" 2>/dev/null || true
  echo "· Tailscale Serve did not start; the dashboard stays loopback-only until it does" >&2
  sed 's/^/  /' "$log" >&2
  return 0
}

if [ "$TAILSCALE" = "1" ]; then
  publish_to_tailnet
fi
