#!/usr/bin/env bash
# Install the brainhouse menu bar helper: compiles menubar/main.swift and
# writes a LaunchAgent (com.brainhouse.menubar) that runs it at login.
# Independent of the server service (com.brainhouse).
#
# Env overrides, baked into the plist:
#   PORT   server port the helper watches (default 8765)
set -euo pipefail
cd "$(dirname "$0")/.."

LABEL="com.brainhouse.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
APP_DIR="$HOME/Library/Application Support/brainhouse"
BIN="$APP_DIR/BrainhouseMenuBar"
PORT="${PORT:-8765}"

if ! command -v swiftc >/dev/null; then
  echo "error: swiftc not found — install the Xcode Command Line Tools: xcode-select --install" >&2
  exit 1
fi

mkdir -p "$APP_DIR" "$HOME/Library/LaunchAgents"
swiftc -O -o "$BIN" menubar/main.swift

# KeepAlive on crash only: quitting from the menu (exit 0) stays quit.
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$BIN</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key><string>$PORT</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
# bootout is asynchronous: bootstrapping while the old job is still winding
# down fails with "Input/output error" (5). Wait for launchd to let go first.
for _ in $(seq 1 50); do
  launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
  sleep 0.1
done
launchctl bootstrap "gui/$(id -u)" "$PLIST"

echo "brainhouse menu bar helper installed (watching :$PORT)"
echo "uninstall: npm run menubar:uninstall"
