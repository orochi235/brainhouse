import { infer } from '../../client/src/components/transforms-inspector/inference.ts';
import { SELECTOR_REGISTRY, resolveSelector } from '../../client/src/transforms/selectors/registry.ts';
import { parseLine } from '../../server/src/parser.ts';
import { clusterKey } from './cluster.mts';
import type { Cluster, ScanResult, SelectorTally } from './types.mts';
import { maxVersion, minVersion } from './version.mts';

/**
 * Core scan over already-read JSONL lines. No filesystem — the CLI feeds
 * lines in so this stays unit-testable. Each line's `version` is read off
 * the raw record and attributed to every Event the line yields.
 *
 * "Unmatched" means the event fired no *name-specific* selector — i.e. it
 * matched only broad catch-all selectors (keys ending with `.any`). This
 * surfaces novel tool names and event shapes that lack their own selector
 * entry even though a broad selector would cover them.
 */
export function scanLines(lines: string[], scanAt: string): ScanResult {
  const perSelector: Record<string, SelectorTally> = {};
  for (const def of SELECTOR_REGISTRY) {
    perSelector[def.key] = { count: 0, minVersion: null, maxVersion: null };
  }

  const matchers: Array<{
    key: string;
    isSpecific: boolean;
    match: (e: ReturnType<typeof parseLine>[number]) => boolean;
  }> = [];
  for (const def of SELECTOR_REGISTRY) {
    try {
      matchers.push({
        key: def.key,
        // A selector is "specific" if its key doesn't end with `.any` —
        // i.e. it names a particular tool, tag, or content pattern.
        isSpecific: !def.key.endsWith('.any'),
        match: resolveSelector(def.key).match,
      });
    } catch (err) {
      process.stderr.write(`[scan] selector "${def.key}" failed to compile: ${String(err)}\n`);
    }
  }

  const clusters = new Map<string, Cluster>();
  const stats = { linesParsed: 0, malformedLines: 0, eventsTotal: 0, eventsMatchedZero: 0 };
  let maxVersionSeen: string | null = null;

  for (const line of lines) {
    let raw: Record<string, unknown>;
    try {
      raw = JSON.parse(line);
    } catch {
      stats.malformedLines++;
      continue;
    }
    stats.linesParsed++;
    const version = typeof raw.version === 'string' ? raw.version : null;
    if (version) maxVersionSeen = maxVersion(maxVersionSeen, version);

    let events: ReturnType<typeof parseLine>;
    try {
      events = parseLine(raw);
    } catch {
      stats.malformedLines++;
      continue;
    }

    for (const e of events) {
      stats.eventsTotal++;
      let matchedSpecific = false;
      for (const m of matchers) {
        if (m.match(e)) {
          const t = perSelector[m.key];
          t.count++;
          t.minVersion = minVersion(t.minVersion, version);
          t.maxVersion = maxVersion(t.maxVersion, version);
          if (m.isSpecific) matchedSpecific = true;
        }
      }
      if (!matchedSpecific) {
        stats.eventsMatchedZero++;
        const key = clusterKey(e);
        const hit = clusters.get(key);
        if (hit) {
          hit.count++;
        } else {
          clusters.set(key, { shapeKey: key, count: 1, sampleEvent: e, draftSelector: infer(e) });
        }
      }
    }
  }

  return {
    perSelector,
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count),
    maxVersionSeen,
    stats,
  };
}
