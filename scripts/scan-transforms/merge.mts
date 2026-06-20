import type { ObservedDb, ObservedEntry, ScanResult } from './types.mts';
import { maxVersion, minVersion } from './version.mts';

/**
 * Fold a scan result into the cumulative sidecar. Version bounds widen
 * forever (survive log pruning); lastWindowCount is replaced with this
 * run's count (0 when unseen). Iterates `result.perSelector`, which holds
 * one entry per registry selector — so the output stays 1:1 with the
 * registry.
 */
export function mergeObserved(existing: ObservedDb, result: ScanResult, scanAt: string): ObservedDb {
  const out: ObservedDb = {};
  for (const [key, tally] of Object.entries(result.perSelector)) {
    const prev = existing[key];
    const entry: ObservedEntry = {
      firstSeenVersion: minVersion(prev?.firstSeenVersion ?? null, tally.minVersion) ?? prev?.firstSeenVersion ?? tally.minVersion ?? 'unknown',
      lastSeenVersion: maxVersion(prev?.lastSeenVersion ?? null, tally.maxVersion) ?? prev?.lastSeenVersion ?? tally.maxVersion ?? 'unknown',
      lastWindowCount: tally.count,
      lastScanAt: scanAt,
    };
    out[key] = entry;
  }
  return out;
}
