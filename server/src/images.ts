/**
 * Content-addressed cache for image bytes lifted out of transcript records.
 *
 * Claude Code inlines pasted images and tool screenshots into the JSONL as
 * base64 — 200KB is a typical block. `parseLine` swaps each blob for an
 * `ImageRef`; this module writes the bytes to `~/.brainhouse/images/` on the
 * way through `TranscriptMonitor.ingest` and serves them back over
 * `GET /api/image/:name`. Panels, the delta stream and the persisted event
 * index therefore hold a 64-char hash instead of the picture.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type ImageRef, imageFileName } from './parser.js';

const MEDIA_TYPE_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bin: 'application/octet-stream',
};

export function imageCacheDir(): string {
  return process.env.BRAINHOUSE_IMAGE_DIR ?? path.join(os.homedir(), '.brainhouse', 'images');
}

/** Validate a `<sha256>.<ext>` request segment and resolve it to a cached
 * file. Returns null for anything that doesn't match exactly — the segment
 * arrives from a URL, so nothing here may reach the filesystem unchecked. */
export function resolveImageFile(name: string): { file: string; mediaType: string } | null {
  const m = /^([0-9a-f]{64})\.([a-z0-9]{2,4})$/.exec(name);
  if (!m) return null;
  const [, sha, ext] = m;
  const mediaType = MEDIA_TYPE_BY_EXTENSION[ext as string];
  if (!mediaType) return null;
  const file = path.join(imageCacheDir(), `${sha}.${ext}`);
  return existsSync(file) ? { file, mediaType } : null;
}

/**
 * Walk a freshly-parsed event, write every carried image blob to the cache,
 * and replace `data` with `sha256` in place. Idempotent and safe on events
 * with no images. A write failure leaves the ref without a `sha256`, which
 * renderers show as a broken-image placeholder rather than crashing.
 */
export function stashEventImages(event: { kind: string; payload: unknown }): void {
  if (event.kind !== 'image' && event.kind !== 'tool_result') return;
  visit(event.payload, 0);
}

function visit(value: unknown, depth: number): void {
  if (depth > 6 || !value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) visit(entry, depth + 1);
    return;
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'brainhouse-image' && typeof obj.data === 'string') {
    stash(obj as unknown as ImageRef);
    return;
  }
  for (const entry of Object.values(obj)) visit(entry, depth + 1);
}

function stash(ref: ImageRef): void {
  const data = ref.data;
  if (!data) return;
  // Hash the base64 rather than the decoded bytes: same content-addressing,
  // and the decode is skipped entirely on the (common) cache hit.
  const sha256 = createHash('sha256').update(data).digest('hex');
  ref.sha256 = sha256;
  delete ref.data;
  const name = imageFileName(ref);
  if (!name) return;
  const file = path.join(imageCacheDir(), name);
  if (existsSync(file)) return;
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, Buffer.from(data, 'base64'));
  } catch (err) {
    console.warn(`[images] failed to cache ${sha256}: ${(err as Error).message}`);
    delete ref.sha256;
  }
}
