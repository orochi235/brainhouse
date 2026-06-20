/** One committed sidecar entry per selector key. */
export interface ObservedEntry {
  firstSeenVersion: string;
  lastSeenVersion: string;
  /** Recomputed fresh each run — current-window activity, not a lifetime total. */
  lastWindowCount: number;
  lastScanAt: string;
}
export type ObservedDb = Record<string, ObservedEntry>;

/** What one scan run saw for one selector. */
export interface SelectorTally {
  count: number;
  minVersion: string | null;
  maxVersion: string | null;
}

/** A bucket of events that matched no selector. */
export interface Cluster {
  shapeKey: string;
  count: number;
  sampleEvent: unknown;
  draftSelector: string;
}

export interface ScanResult {
  /** Keyed by selector key — one entry per registry selector, even count 0. */
  perSelector: Record<string, SelectorTally>;
  clusters: Cluster[];
  maxVersionSeen: string | null;
  stats: {
    linesParsed: number;
    malformedLines: number;
    eventsTotal: number;
    eventsUnmatchedSpecific: number;
  };
}
