/**
 * The transcripts icehouse has stored, keyed by the path each had when live.
 * No handle on the store outlives a call: it sits on an external drive, and an
 * open file would block ejecting it.
 */

import type { Entry } from 'icehouse';
import { bufferSource, type Source } from './reader.js';

type Icehouse = typeof import('icehouse');

/**
 * `none`: icehouse is not set up, so a deleted transcript is simply gone.
 * `unreachable`: it is set up but its drive is away, so nothing can be said
 * about what is stored.
 */
export type ArchiveState = 'none' | 'unreachable' | 'open';

export interface StoredOptions {
  /** The store's directory; icehouse's default when absent. */
  dir?: string;
  /** Home directory the stored paths are rebuilt under. */
  home?: string;
}

export class StoredTranscripts {
  state: ArchiveState = 'none';
  private lib: Icehouse | null = null;
  private entries = new Map<string, Entry>();
  private held: { path: string; source: Source } | null = null;

  constructor(private readonly opts: StoredOptions = {}) {}

  /** Read the store's list of transcripts again. */
  async refresh(): Promise<void> {
    this.lib ??= await import('icehouse').catch(() => null);
    if (!this.lib) {
      this.state = 'none';
      return;
    }
    try {
      const archive = this.lib.openArchive(this.opts.dir);
      if (!archive) {
        this.state = 'none';
        this.entries = new Map();
        return;
      }
      try {
        const entries = new Map<string, Entry>();
        for (const e of archive.transcripts()) {
          entries.set(this.lib.sourcePath(e.root, e.rel, this.opts.home), e);
        }
        this.entries = entries;
        this.state = 'open';
      } finally {
        archive.close();
      }
    } catch {
      this.state = 'unreachable';
    }
  }

  entry(p: string): Entry | undefined {
    return this.entries.get(p);
  }

  paths(): string[] {
    return [...this.entries.keys()];
  }

  /** The stored copy of `p`, decompressed and held until `release` or the
   * next path, so a transcript read over several steps is unpacked once. */
  source(p: string): Source {
    if (this.held?.path === p) return this.held.source;
    this.held = null;
    const entry = this.entries.get(p);
    const archive = entry && this.lib?.openArchive(this.opts.dir);
    if (!entry || !archive) throw new Error(`no stored copy of ${p}`);
    try {
      const source = bufferSource(archive.read(entry.root, entry.rel), entry.mtimeMs);
      this.held = { path: p, source };
      return source;
    } finally {
      archive.close();
    }
  }

  release(): void {
    this.held = null;
  }
}
