import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeObserved } from './scan-transforms/merge.mts';
import { scanLines } from './scan-transforms/scan.mts';
import type { ObservedDb } from './scan-transforms/types.mts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OBSERVED_PATH = join(HERE, '..', 'client', 'src', 'transforms', 'selectors', 'observed.json');
const OUT_DIR = join(HERE, '.scan-out');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(name);

function findLogs(root: string, sinceMs: number | null): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith('.jsonl')) {
        if (sinceMs == null || statSync(p).mtimeMs >= sinceMs) out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

function main() {
  const root = arg('--root') ?? join(homedir(), '.claude', 'projects');
  if (!existsSync(root)) {
    process.stderr.write(`[scan] log root not found: ${root}\n`);
    process.exit(1);
  }
  const sinceDays = hasFlag('--all') ? null : Number.parseInt(arg('--since') ?? '14', 10);
  const sinceMs = sinceDays == null ? null : Date.now() - sinceDays * 86_400_000;
  const scanAt = new Date().toISOString();

  const files = findLogs(root, sinceMs);
  const lines: string[] = [];
  for (const f of files) {
    for (const l of readFileSync(f, 'utf8').split('\n')) {
      if (l.trim().length > 0) lines.push(l);
    }
  }

  const result = scanLines(lines, scanAt);

  const existing: ObservedDb = existsSync(OBSERVED_PATH)
    ? JSON.parse(readFileSync(OBSERVED_PATH, 'utf8'))
    : {};
  const merged = mergeObserved(existing, result, scanAt);
  writeFileSync(OBSERVED_PATH, `${JSON.stringify(merged, null, 2)}\n`);

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(join(OUT_DIR, 'unmatched-candidates.json'), `${JSON.stringify(result.clusters, null, 2)}\n`);

  const maxV = result.maxVersionSeen ?? 'unknown';
  const stale = Object.entries(merged)
    .filter(([, e]) => e.lastWindowCount === 0)
    .map(([k]) => k);
  const lagging = Object.entries(merged)
    .filter(([, e]) => e.lastWindowCount > 0 && result.maxVersionSeen != null && e.lastSeenVersion !== result.maxVersionSeen)
    .map(([k]) => k);

  process.stdout.write(
    [
      `scan-transforms — ${files.length} files, ${result.stats.linesParsed} lines (${result.stats.malformedLines} malformed), ${result.stats.eventsTotal} events`,
      `max Claude version seen: ${maxV}`,
      `live selectors: ${Object.values(merged).filter((e) => e.lastWindowCount > 0).length}/${Object.keys(merged).length}`,
      stale.length ? `NOT SEEN this window (stale candidates): ${stale.join(', ')}` : 'no unseen selectors',
      lagging.length ? `lastSeenVersion < ${maxV}: ${lagging.join(', ')}` : '',
      `unmatched clusters: ${result.clusters.length} → ${join(OUT_DIR, 'unmatched-candidates.json')}`,
      'top clusters:',
      ...result.clusters.slice(0, 10).map((c) => `  ${c.count.toString().padStart(5)}  ${c.shapeKey}   draft: ${c.draftSelector}`),
    ].filter(Boolean).join('\n') + '\n',
  );
}

main();
