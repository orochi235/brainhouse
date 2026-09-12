#!/usr/bin/env bash
# Quit the brainhouse menu bar helper and remove its LaunchAgent and app.
set -euo pipefail
cd "$(dirname "$0")/.."

if command -v perch >/dev/null; then
  perch uninstall
else
  # perch is what wrote these; removing them by hand is the fallback for a
  # machine that no longer has it.
  launchctl bootout "gui/$(id -u)/com.brainhouse.menubar" 2>/dev/null || true
  rm -f "$HOME/Library/LaunchAgents/com.brainhouse.menubar.plist"
  rm -rf "$HOME/Applications/brainhouse.app"
fi

# Left behind by installs older than the perch port.
rm -rf "$HOME/Library/Application Support/brainhouse/BrainhouseMenuBar.app"
rm -f "$HOME/Library/Application Support/brainhouse/BrainhouseMenuBar"

echo "brainhouse menu bar helper uninstalled"
