#!/usr/bin/env node
/**
 * Workaround for npm/cli#4828 (optional-deps arch resolution bug).
 *
 * On every install, ensure BOTH darwin-x64 and darwin-arm64 platform
 * binaries for rollup and esbuild are present. npm normally only installs
 * the one matching `process.arch` at install time, but child processes
 * (Vite workers, `run-p` subshells, anything launched under Rosetta) can
 * report a different `process.arch` at runtime and explode.
 *
 * Pinning to the exact resolved version (read from the already-installed
 * arm64 binary's package.json) avoids the previous "*" version trick that
 * cross-resolved esbuild to a major version vitest's nested copy didn't
 * expect.
 *
 * Skipped on non-darwin hosts so Linux/Windows installs aren't slowed down.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'darwin') process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Each row: (anchor we read the version from, cross-arch package we want).
//
// We deliberately only handle rollup. Esbuild has multiple nested copies
// in our tree at different versions (vite has esbuild@0.25.x, vitest has
// 0.21.x, vite's own deps pull 0.28.x); installing one cross-arch binary
// at the hoisted level fights with the version vite's nested JS expects.
// If we hit the same arch problem with esbuild later, the right fix is to
// walk every nested esbuild and shim them individually — but rollup-only
// covers the failure mode we've actually seen.
const pairs = [['@rollup/rollup-darwin-arm64', '@rollup/rollup-darwin-x64']];

// Always install ALL counterparts in one command, even if some are already
// present. `npm install --no-save` prunes anything not in the resolved
// tree, so a *second* invocation that omits a previously-installed
// counterpart would remove it again. One install with both counterparts
// avoids that pruning trap.
const toInstall = [];
for (const [anchor, counterpart] of pairs) {
  const anchorPkg = path.join(root, 'node_modules', anchor, 'package.json');
  if (!existsSync(anchorPkg)) continue;
  const version = JSON.parse(readFileSync(anchorPkg, 'utf8')).version;
  toInstall.push(`${counterpart}@${version}`);
}

if (toInstall.length === 0) process.exit(0);

// Cheap idempotency: if both counterparts are already installed at the
// right versions, skip the install entirely so a no-op postinstall doesn't
// thrash node_modules.
const allPresent = pairs.every(([anchor, counterpart]) => {
  const counterPkg = path.join(root, 'node_modules', counterpart, 'package.json');
  if (!existsSync(counterPkg)) return false;
  const anchorPkg = path.join(root, 'node_modules', anchor, 'package.json');
  const counterVer = JSON.parse(readFileSync(counterPkg, 'utf8')).version;
  const anchorVer = JSON.parse(readFileSync(anchorPkg, 'utf8')).version;
  return counterVer === anchorVer;
});
if (allPresent) process.exit(0);

console.log(`[ensure-platform-binaries] installing ${toInstall.join(' ')}`);

// One command so npm doesn't prune the previous install when adding the next.
// --force overrides cpu/os mismatch (we explicitly want the cross-arch binary).
try {
  execSync(
    `npm install --no-save --no-package-lock --force --silent ${toInstall.join(' ')}`,
    { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] },
  );
} catch (err) {
  console.warn(`[ensure-platform-binaries] install failed: ${err.message}`);
}
