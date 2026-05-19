#!/usr/bin/env node
/**
 * brainhouse CLI entry.
 *   brainhouse              — boot the server (default)
 *   brainhouse init [flags] — install hook dispatcher into Claude Code settings
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const sub = process.argv[2];

if (sub === 'init') {
  const { runInit } = await import('./init.js');
  await runInit(process.argv.slice(3));
} else if (sub === '--help' || sub === '-h') {
  console.log('Usage: brainhouse [init [--uninstall|--dry-run]]');
} else {
  const entry = path.resolve(here, '..', 'server', 'dist', 'index.js');
  if (!existsSync(entry)) {
    console.error('brainhouse: server build not found at', entry);
    console.error('Run `npm run build` in the brainhouse repo first.');
    process.exit(1);
  }
  await import(pathToFileURL(entry).href);
}
