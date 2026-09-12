#!/usr/bin/env bash
# Install the brainhouse menu bar helper. The app is generated from
# menubar.yaml by perch, which compiles it, bundles it, writes the LaunchAgent
# and bootstraps it. Independent of the server service (com.brainhouse).
set -euo pipefail
cd "$(dirname "$0")/.."

if ! command -v perch >/dev/null; then
  echo "error: perch not found — go install github.com/orochi235/perch/cmd/perch@latest" >&2
  echo "       (and make sure the directory it installs to is on your PATH)" >&2
  exit 1
fi

perch install

# The helper used to live under Application Support and is now a normal app in
# ~/Applications. The label is unchanged, so perch has already replaced the
# LaunchAgent; only the old bundle is left to remove.
rm -rf "$HOME/Library/Application Support/brainhouse/BrainhouseMenuBar.app"

echo "brainhouse menu bar helper installed (watching :8765)"
echo "uninstall: npm run menubar:uninstall"
