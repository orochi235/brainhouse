#!/usr/bin/env bash
# Stop the brainhouse LaunchAgent and remove its plist. Logs in
# ~/Library/Logs/brainhouse are left alone.
set -euo pipefail

LABEL="com.brainhouse"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$PLIST"
echo "brainhouse service uninstalled"
