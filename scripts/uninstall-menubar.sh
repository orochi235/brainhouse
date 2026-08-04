#!/usr/bin/env bash
# Quit the brainhouse menu bar helper and remove its LaunchAgent and binary.
set -euo pipefail

LABEL="com.brainhouse.menubar"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
BIN="$HOME/Library/Application Support/brainhouse/BrainhouseMenuBar"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST" "$BIN"
echo "brainhouse menu bar helper uninstalled"
