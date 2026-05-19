#!/usr/bin/env node
/**
 * brainhouse CLI entry. Boots the built server from server/dist/index.js.
 * If the build is missing, point the user at `npm run build`.
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.resolve(here, '..', 'server', 'dist', 'index.js');

if (!existsSync(entry)) {
  console.error('brainhouse: server build not found at', entry);
  console.error('Run `npm run build` in the brainhouse repo first.');
  process.exit(1);
}

await import(pathToFileURL(entry).href);
