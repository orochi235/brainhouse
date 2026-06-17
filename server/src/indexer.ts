import type { Event } from './parser.js';
import type { SessionSummaryRow } from './store.js';

export interface IndexerDeps {
  /** Pull (and clear) the full set of outstanding files; the indexer paces
   * them itself in batches of `batchSize`. */
  takeFiles: () => string[];
  parseFile: (absPath: string) => Promise<Event[]>;
  summarize: (events: Event[]) => SessionSummaryRow | null;
  write: (row: SessionSummaryRow) => void;
  batchSize: number;
  intervalMs: number;
}

/** Throttled background summarizer. Drains a queue of older transcript files
 * into session_summary, never creating panels or emitting deltas. */
export class BackgroundIndexer {
  private stopped = false;
  constructor(private readonly deps: IndexerDeps) {}

  stop(): void {
    this.stopped = true;
  }

  /** Process the entire queue, pausing `intervalMs` between batches. Resolves
   * when drained or stopped. A single bad file is swallowed so it can't wedge
   * the pass. */
  async runToCompletion(): Promise<void> {
    const queue = this.deps.takeFiles();
    let i = 0;
    while (i < queue.length && !this.stopped) {
      const batch = queue.slice(i, i + this.deps.batchSize);
      i += this.deps.batchSize;
      for (const file of batch) {
        if (this.stopped) return;
        try {
          const events = await this.deps.parseFile(file);
          if (events.length === 0) continue;
          const row = this.deps.summarize(events);
          if (row) this.deps.write(row);
        } catch {
          // skip unreadable/unparseable file
        }
      }
      if (i < queue.length && !this.stopped && this.deps.intervalMs > 0) {
        await new Promise((r) => setTimeout(r, this.deps.intervalMs));
      }
    }
  }
}
