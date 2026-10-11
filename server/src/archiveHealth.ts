/**
 * Whether icehouse's hourly archive runs still happen, for the menu bar
 * helper. icehouse owns the rule and the wording; this reads its verdict and
 * decides when a warning has held long enough to interrupt with a banner.
 */
type Icehouse = typeof import('icehouse');

export interface ArchiveVerdict {
  warn: boolean;
  text: string;
}

export interface ArchiveHealthOptions {
  notify: (title: string, body: string) => void;
  /** Test seams — default to icehouse's record and the wall clock. */
  read?: () => Promise<ArchiveVerdict | null>;
  now?: () => number;
}

const GRACE_MS = 10 * 60_000;

let lib: Icehouse | null = null;
/** Null when icehouse is not installed or has never recorded a run. */
async function readVerdict(): Promise<ArchiveVerdict | null> {
  lib ??= await import('icehouse').catch(() => null);
  const health = lib?.readHealth();
  return lib && health ? lib.verdict(health) : null;
}

export class ArchiveHealth {
  /** What is wrong, in icehouse's words; empty while nothing is. */
  warning = '';
  private since: number | null = null;
  private notified = false;
  private readonly read: () => Promise<ArchiveVerdict | null>;
  private readonly now: () => number;

  constructor(private readonly opts: ArchiveHealthOptions) {
    this.read = opts.read ?? readVerdict;
    this.now = opts.now ?? (() => Date.now());
  }

  async check(): Promise<void> {
    const v = await this.read().catch(() => null);
    if (!v?.warn) {
      this.warning = '';
      this.since = null;
      this.notified = false;
      return;
    }
    this.warning = v.text;
    this.since ??= this.now();
    // One banner per episode, and none for a warning that clears on the next run.
    if (!this.notified && this.now() - this.since >= GRACE_MS) {
      this.notified = true;
      this.opts.notify('icehouse needs attention', v.text);
    }
  }
}
