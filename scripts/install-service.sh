#!/usr/bin/env bash
# Install brainhouse as a macOS LaunchAgent: builds the app, writes a plist
# that runs it at login (and keeps it alive), and starts it now.
#
# Env overrides, baked into the plist:
#   PORT   listen port (default 8765)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$(pwd)"

LABEL="com.brainhouse"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$HOME/Library/Logs/brainhouse"
NODE_BIN="$(command -v node)"
PORT="${PORT:-8765}"

# Boot out any prior install first so a reinstall over the running service
# doesn't trip the port check below (the check is for foreign dev servers).
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
for _ in $(seq 1 50); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "error: port $PORT is already in use (a dev server?)." >&2
  echo "Stop it first, or install on another port: PORT=8766 $0" >&2
  exit 1
fi

npm run build

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents"

# /usr/sbin matters: the process tracker shells out to `lsof` (ports + cwd
# sweeps), which lives there. Without it the Network view silently empties.
# ~/.local/bin: claude CLI (titler fallback). /usr/sbin: lsof (process
# sweeps). Dropping either silently kills its feature under launchd.
SERVICE_PATH="$(dirname "$NODE_BIN"):$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN</string>
    <string>$ROOT/server/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$SERVICE_PATH</string>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$LOG_DIR/stdout.log</string>
  <key>StandardErrorPath</key><string>$LOG_DIR/stderr.log</string>
</dict>
</plist>
EOF

launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "brainhouse service installed → http://localhost:$PORT"
echo "logs:    $LOG_DIR"
echo "restart: launchctl kickstart -k gui/\$(id -u)/$LABEL"
