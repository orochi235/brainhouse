/**
 * Brainhouse persistence layer — a synchronous SQLite wrapper that keeps
 * three kinds of state across server restarts:
 *
 *   1. **UI intentions** (pin / wide / manual_order / user_mini /
 *      hidden_at / auto_mini_at). Sticky across restarts so the user's
 *      manual arrangement survives a reboot.
 *
 *   2. **Live panel snapshots** (everything from `Panel` in session.ts).
 *      On boot, SessionStore hydrates from here first, then the watcher
 *      catches up from `bootstrap_offsets`.
 *
 *   3. **Long-term session summaries** (`session_summary`). Materialized
 *      when a session transitions out of `live` (or `ended` flips true).
 *      Carries memory-feed fields — key files, last decision, open
 *      threads — so future work can pipe summaries back into Claude as
 *      context. Forever-retention by default; the underlying JSONL
 *      remains canonical for re-parse on demand.
 *
 * Plus `events_index` — a windowed per-event log with a configurable
 * retention (default 30 days). Used for fast cross-session queries
 * ("which sessions touched this file?") without re-scanning JSONLs.
 *
 * Design constraints we explicitly *aren't* paying for here:
 *   - sync correctness (tombstones, vector clocks). Brainhouse is local-
 *     only for now; UUIDs are the natural keys so a future sync path
 *     stays open without claiming readiness today.
 *   - async I/O. SessionStore is synchronous; node:sqlite is too; no
 *     reason to introduce promise plumbing.
 *
 * The DB lives at `~/.brainhouse/state.db` by default; override with
 * `BRAINHOUSE_DB` for tests / sandboxing.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

// Vite's resolver doesn't recognize `node:sqlite` (newer built-in) as a
// node-external by default, so a bare `import { DatabaseSync } from
// 'node:sqlite'` blows up under vitest. createRequire bypasses the
// bundler entirely and loads the built-in via Node's own resolver.
const require = createRequire(import.meta.url);
// biome-ignore lint/suspicious/noExplicitAny: node:sqlite types are minimal under the createRequire path
const { DatabaseSync } = require('node:sqlite') as { DatabaseSync: any };
// biome-ignore lint/suspicious/noExplicitAny: same as above
type DatabaseSync = any;

export const SCHEMA_VERSION = 2;

export interface IntentionsRow {
  panel_id: string;
  pinned: boolean;
  wide: boolean;
  manual_order: number | null;
  user_mini: boolean;
  hidden_at: number | null;
  auto_mini_at: number | null;
  /** Subagent that's been pulled out of its parent's nested tray and
   * promoted to a top-level grid panel. Only meaningful for kind=subagent. */
  broken_out: boolean;
  /** User pulled this panel out of the dock; the allocator should give it a
   * grid slot unconditionally (treated like `pinned` for placement, but
   * cleared as soon as the user dismisses again). */
  user_kept: boolean;
  updated_at: number;
}

export interface PanelRow {
  id: string;
  kind: 'parent' | 'subagent';
  parent_panel_id: string | null;
  title: string;
  agent_type: string | null;
  account_label: string | null;
  status: 'live' | 'done' | 'mini';
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  cwd: string | null;
  /** Closest `.git` ancestor of `cwd`. Null when no repo root was found. */
  repo_root: string | null;
  theme_bg: string | null;
  theme_fg: string | null;
  binned_at: number | null;
  awaiting_input: boolean;
  ended: boolean;
  /** True if the title was set via /rename. Survives restart. */
  manually_renamed: boolean;
  /** How we learned the session ended. Null when ended=false. */
  ended_provenance:
    | 'hook_stop'
    | 'hook_subagent_stop'
    | 'hook_session_end'
    | 'hook_session_start_supersede'
    | 'idle_timeout'
    | 'server_close'
    | 'progress_complete'
    | 'bootstrap_stale'
    | null;
  updated_at: number;
}

export interface EventIndexRow {
  panel_id: string;
  event_uuid: string;
  /** Epoch seconds. */
  ts: number;
  kind: string;
  tool_name: string | null;
  file_path: string | null;
  /** Bounded short text — full content stays in the JSONL on disk. */
  summary: string | null;
}

export interface EventStatsRow {
  kind: string;
  /** Second-axis breakdown: tool name for tool_use, ok/error for
   * tool_result, model id for resource_usage, subtype for system,
   * record_type for meta. Empty string when no useful subkey applies. */
  subkey: string;
  count: number;
  /** Epoch seconds of the most recent event matching (kind, subkey). */
  last_seen: number;
}

export interface SessionSummaryRow {
  session_id: string;
  kind: 'parent' | 'subagent';
  parent_session_id: string | null;
  account_label: string | null;
  title: string | null;
  agent_type: string | null;
  cwd: string | null;
  started_at: number;
  ended_at: number;
  /** Approximate live-time in seconds (sum of `live` intervals). */
  duration_active_s: number;
  ended_provenance:
    | 'hook_stop'
    | 'hook_subagent_stop'
    | 'hook_session_end'
    | 'hook_session_start_supersede'
    | 'idle_timeout'
    | 'server_close'
    | 'progress_complete'
    | 'bootstrap_stale'
    | 'never';
  event_count: number;
  tool_call_count: number;
  error_count: number;
  unique_files_touched: number;
  /** JSON: `{ "Bash": 40, "Read": 25, ... }`. Top-N keys. */
  tool_mix_json: string;
  /** JSON: top-N file paths by Edit/Write count. */
  key_files_json: string;
  /** Free text — last assistant_text near session end, truncated. */
  key_decisions: string | null;
  /** JSON: list of unresolved tool errors + unanswered user questions. */
  open_threads_json: string | null;
  /** JSON: snapshot of the pinned checklist state at session end. */
  pinned_checklist_json: string | null;
  /** When this row was materialized. */
  rolled_up_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY
);

CREATE TABLE IF NOT EXISTS bootstrap_offsets (
  file_path    TEXT PRIMARY KEY,
  byte_offset  INTEGER NOT NULL,
  last_seen_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS intentions (
  panel_id     TEXT PRIMARY KEY,
  pinned       INTEGER NOT NULL DEFAULT 0,
  wide         INTEGER NOT NULL DEFAULT 0,
  manual_order INTEGER,
  user_mini    INTEGER NOT NULL DEFAULT 0,
  hidden_at    REAL,
  auto_mini_at REAL,
  broken_out   INTEGER NOT NULL DEFAULT 0,
  user_kept INTEGER NOT NULL DEFAULT 0,
  updated_at   REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS panels (
  id                TEXT PRIMARY KEY,
  kind              TEXT NOT NULL,
  parent_panel_id   TEXT,
  title             TEXT NOT NULL,
  agent_type        TEXT,
  account_label     TEXT,
  status            TEXT NOT NULL,
  started_at        REAL NOT NULL,
  last_event_at     REAL NOT NULL,
  status_changed_at REAL NOT NULL,
  cwd               TEXT,
  repo_root         TEXT,
  theme_bg          TEXT,
  theme_fg          TEXT,
  binned_at         REAL,
  awaiting_input    INTEGER NOT NULL DEFAULT 0,
  ended             INTEGER NOT NULL DEFAULT 0,
  ended_provenance  TEXT,
  manually_renamed  INTEGER NOT NULL DEFAULT 0,
  updated_at        REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS panels_cwd    ON panels (cwd);
CREATE INDEX IF NOT EXISTS panels_parent ON panels (parent_panel_id);

CREATE TABLE IF NOT EXISTS events_index (
  panel_id   TEXT NOT NULL,
  event_uuid TEXT NOT NULL,
  ts         REAL NOT NULL,
  kind       TEXT NOT NULL,
  tool_name  TEXT,
  file_path  TEXT,
  summary    TEXT,
  PRIMARY KEY (panel_id, event_uuid)
);
CREATE INDEX IF NOT EXISTS events_index_ts       ON events_index (ts);
CREATE INDEX IF NOT EXISTS events_index_panel_ts ON events_index (panel_id, ts);
CREATE INDEX IF NOT EXISTS events_index_file     ON events_index (file_path);

CREATE TABLE IF NOT EXISTS session_summary (
  session_id            TEXT PRIMARY KEY,
  kind                  TEXT NOT NULL,
  parent_session_id     TEXT,
  account_label         TEXT,
  title                 TEXT,
  agent_type            TEXT,
  cwd                   TEXT,
  started_at            REAL NOT NULL,
  ended_at              REAL NOT NULL,
  duration_active_s     REAL NOT NULL,
  ended_provenance      TEXT NOT NULL,
  event_count           INTEGER NOT NULL,
  tool_call_count       INTEGER NOT NULL,
  error_count           INTEGER NOT NULL,
  unique_files_touched  INTEGER NOT NULL,
  tool_mix_json         TEXT NOT NULL,
  key_files_json        TEXT NOT NULL,
  key_decisions         TEXT,
  open_threads_json     TEXT,
  pinned_checklist_json TEXT,
  rolled_up_at          REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS session_summary_cwd     ON session_summary (cwd);
CREATE INDEX IF NOT EXISTS session_summary_started ON session_summary (started_at);
CREATE INDEX IF NOT EXISTS session_summary_parent  ON session_summary (parent_session_id);

-- Cross-session frequency counters for "what event types do we actually see".
-- Cheap to maintain (one UPSERT per ingested event); read via getEventStats()
-- to drive the debug StatsModal. subkey is the second-axis breakdown: tool
-- name for tool_use, ok/error for tool_result, model for resource_usage,
-- subtype for system, record_type for meta. Empty string for kinds without
-- a useful subkey (user_text, assistant_text, thinking).
CREATE TABLE IF NOT EXISTS event_stats (
  kind      TEXT NOT NULL,
  subkey    TEXT NOT NULL,
  count     INTEGER NOT NULL DEFAULT 0,
  last_seen REAL NOT NULL,
  PRIMARY KEY (kind, subkey)
);
`;

function defaultDbPath(): string {
  if (process.env.BRAINHOUSE_DB) return path.resolve(process.env.BRAINHOUSE_DB);
  return path.join(os.homedir(), '.brainhouse', 'state.db');
}

export class Store {
  private readonly db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  /** Open (or create) the DB at the given path and run migrations. Use
   * `':memory:'` for a transient in-test database. */
  static open(filePath: string = defaultDbPath()): Store {
    if (filePath !== ':memory:') {
      const dir = path.dirname(filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    }
    const db = new DatabaseSync(filePath);
    db.exec('PRAGMA journal_mode = WAL');
    db.exec('PRAGMA foreign_keys = ON');
    db.exec(SCHEMA);
    db.exec(`INSERT OR IGNORE INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);
    // Idempotent column adds for forward-compat with older databases. Each
    // wrapped in try/catch so re-running on an up-to-date DB is a no-op.
    try {
      db.exec('ALTER TABLE intentions ADD COLUMN broken_out INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already exists
    }
    try {
      db.exec(
        'ALTER TABLE intentions ADD COLUMN user_kept INTEGER NOT NULL DEFAULT 0',
      );
    } catch {
      // column already exists
    }
    try {
      db.exec('ALTER TABLE panels ADD COLUMN manually_renamed INTEGER NOT NULL DEFAULT 0');
    } catch {
      // column already exists
    }
    try {
      db.exec('ALTER TABLE panels ADD COLUMN repo_root TEXT');
    } catch {
      // column already exists
    }
    return new Store(db);
  }

  close(): void {
    this.db.close();
  }

  // ---- intentions ----

  getIntentions(panelId: string): IntentionsRow | null {
    const row = this.db.prepare('SELECT * FROM intentions WHERE panel_id = ?').get(panelId) as
      | RawIntentions
      | undefined;
    return row ? deserializeIntentions(row) : null;
  }

  allIntentions(): IntentionsRow[] {
    const rows = this.db.prepare('SELECT * FROM intentions').all() as RawIntentions[];
    return rows.map(deserializeIntentions);
  }

  upsertIntentions(row: IntentionsRow): void {
    this.db
      .prepare(
        `INSERT INTO intentions
           (panel_id, pinned, wide, manual_order, user_mini, hidden_at, auto_mini_at, broken_out, user_kept, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(panel_id) DO UPDATE SET
           pinned           = excluded.pinned,
           wide             = excluded.wide,
           manual_order     = excluded.manual_order,
           user_mini        = excluded.user_mini,
           hidden_at        = excluded.hidden_at,
           auto_mini_at     = excluded.auto_mini_at,
           broken_out       = excluded.broken_out,
           user_kept = excluded.user_kept,
           updated_at       = excluded.updated_at`,
      )
      .run(
        row.panel_id,
        row.pinned ? 1 : 0,
        row.wide ? 1 : 0,
        row.manual_order,
        row.user_mini ? 1 : 0,
        row.hidden_at,
        row.auto_mini_at,
        row.broken_out ? 1 : 0,
        row.user_kept ? 1 : 0,
        row.updated_at,
      );
  }

  deleteIntentions(panelId: string): void {
    this.db.prepare('DELETE FROM intentions WHERE panel_id = ?').run(panelId);
  }

  // ---- panels (current model snapshot) ----

  getPanel(id: string): PanelRow | null {
    const row = this.db.prepare('SELECT * FROM panels WHERE id = ?').get(id) as
      | RawPanel
      | undefined;
    return row ? deserializePanel(row) : null;
  }

  allPanels(): PanelRow[] {
    const rows = this.db.prepare('SELECT * FROM panels').all() as RawPanel[];
    return rows.map(deserializePanel);
  }

  upsertPanel(row: PanelRow): void {
    this.db
      .prepare(
        `INSERT INTO panels
           (id, kind, parent_panel_id, title, agent_type, account_label, status,
            started_at, last_event_at, status_changed_at, cwd, repo_root, theme_bg, theme_fg,
            binned_at, awaiting_input, ended, ended_provenance, manually_renamed, updated_at)
         VALUES
           (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind              = excluded.kind,
           parent_panel_id   = excluded.parent_panel_id,
           title             = excluded.title,
           agent_type        = excluded.agent_type,
           account_label     = excluded.account_label,
           status            = excluded.status,
           started_at        = excluded.started_at,
           last_event_at     = excluded.last_event_at,
           status_changed_at = excluded.status_changed_at,
           cwd               = excluded.cwd,
           repo_root         = excluded.repo_root,
           theme_bg          = excluded.theme_bg,
           theme_fg          = excluded.theme_fg,
           binned_at         = excluded.binned_at,
           awaiting_input    = excluded.awaiting_input,
           ended             = excluded.ended,
           ended_provenance  = excluded.ended_provenance,
           manually_renamed  = excluded.manually_renamed,
           updated_at        = excluded.updated_at`,
      )
      .run(
        row.id,
        row.kind,
        row.parent_panel_id,
        row.title,
        row.agent_type,
        row.account_label,
        row.status,
        row.started_at,
        row.last_event_at,
        row.status_changed_at,
        row.cwd,
        row.repo_root,
        row.theme_bg,
        row.theme_fg,
        row.binned_at,
        row.awaiting_input ? 1 : 0,
        row.ended ? 1 : 0,
        row.ended_provenance,
        row.manually_renamed ? 1 : 0,
        row.updated_at,
      );
  }

  deletePanel(id: string): void {
    this.db.prepare('DELETE FROM panels WHERE id = ?').run(id);
  }

  /** Wipe every persisted trace of a panel: events_index rows, session
   * summary, intentions, and the panels row. Used by the dev "rebuild
   * from log" affordance so the subsequent re-bootstrap reconstructs
   * the panel from scratch. Caller is responsible for also clearing
   * any matching `bootstrap_offsets` rows. */
  purgePanel(id: string): void {
    this.db.prepare('DELETE FROM events_index WHERE panel_id = ?').run(id);
    this.db.prepare('DELETE FROM session_summary WHERE session_id = ?').run(id);
    this.db.prepare('DELETE FROM intentions WHERE panel_id = ?').run(id);
    this.db.prepare('DELETE FROM panels WHERE id = ?').run(id);
  }

  // ---- events_index (windowed event log) ----

  recordEvent(row: EventIndexRow): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events_index
           (panel_id, event_uuid, ts, kind, tool_name, file_path, summary)
         VALUES
           (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.panel_id,
        row.event_uuid,
        row.ts,
        row.kind,
        row.tool_name,
        row.file_path,
        row.summary,
      );
  }

  /** Drop rows older than the cutoff; returns the number of rows removed. */
  pruneEventsBefore(cutoffTs: number): number {
    const res = this.db.prepare('DELETE FROM events_index WHERE ts < ?').run(cutoffTs);
    return Number(res.changes);
  }

  eventsForPanel(panelId: string, limit = 1000): EventIndexRow[] {
    return this.db
      .prepare('SELECT * FROM events_index WHERE panel_id = ? ORDER BY ts ASC LIMIT ?')
      .all(panelId, limit) as EventIndexRow[];
  }

  // ---- event_stats (cross-session frequency counters) ----

  /** Bump the count for one (kind, subkey) pair. UPSERT semantics: row
   * gets created on first hit, count + last_seen advance thereafter.
   * Idempotent only at the row level (callers shouldn't call this twice
   * for the same uuid; persistEvent's caller is responsible for that). */
  incrementEventStat(kind: string, subkey: string, ts: number): void {
    this.db
      .prepare(
        `INSERT INTO event_stats (kind, subkey, count, last_seen)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(kind, subkey) DO UPDATE SET
           count     = count + 1,
           last_seen = MAX(last_seen, excluded.last_seen)`,
      )
      .run(kind, subkey, ts);
  }

  /** All (kind, subkey, count, last_seen) rows, count-desc then kind asc. */
  getEventStats(): EventStatsRow[] {
    return this.db
      .prepare(
        'SELECT kind, subkey, count, last_seen FROM event_stats ORDER BY count DESC, kind ASC',
      )
      .all() as EventStatsRow[];
  }

  /** Every row newer than `sinceTs`, ordered by panel then ts. Used by
   * cross-session aggregators (e.g. the flows sankey) that need to walk
   * each session's chronological event sequence. */
  eventsSince(sinceTs: number): EventIndexRow[] {
    return this.db
      .prepare('SELECT * FROM events_index WHERE ts >= ? ORDER BY panel_id ASC, ts ASC')
      .all(sinceTs) as EventIndexRow[];
  }

  eventsTouchingFile(filePath: string, limit = 200): EventIndexRow[] {
    return this.db
      .prepare('SELECT * FROM events_index WHERE file_path = ? ORDER BY ts DESC LIMIT ?')
      .all(filePath, limit) as EventIndexRow[];
  }

  // ---- session_summary (forever) ----

  materializeSession(row: SessionSummaryRow): void {
    this.db
      .prepare(
        `INSERT INTO session_summary
           (session_id, kind, parent_session_id, account_label, title, agent_type, cwd,
            started_at, ended_at, duration_active_s, ended_provenance,
            event_count, tool_call_count, error_count, unique_files_touched,
            tool_mix_json, key_files_json, key_decisions, open_threads_json,
            pinned_checklist_json, rolled_up_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET
           kind                  = excluded.kind,
           parent_session_id     = excluded.parent_session_id,
           account_label         = excluded.account_label,
           title                 = excluded.title,
           agent_type            = excluded.agent_type,
           cwd                   = excluded.cwd,
           started_at            = excluded.started_at,
           ended_at              = excluded.ended_at,
           duration_active_s     = excluded.duration_active_s,
           ended_provenance      = excluded.ended_provenance,
           event_count           = excluded.event_count,
           tool_call_count       = excluded.tool_call_count,
           error_count           = excluded.error_count,
           unique_files_touched  = excluded.unique_files_touched,
           tool_mix_json         = excluded.tool_mix_json,
           key_files_json        = excluded.key_files_json,
           key_decisions         = excluded.key_decisions,
           open_threads_json     = excluded.open_threads_json,
           pinned_checklist_json = excluded.pinned_checklist_json,
           rolled_up_at          = excluded.rolled_up_at`,
      )
      .run(
        row.session_id,
        row.kind,
        row.parent_session_id,
        row.account_label,
        row.title,
        row.agent_type,
        row.cwd,
        row.started_at,
        row.ended_at,
        row.duration_active_s,
        row.ended_provenance,
        row.event_count,
        row.tool_call_count,
        row.error_count,
        row.unique_files_touched,
        row.tool_mix_json,
        row.key_files_json,
        row.key_decisions,
        row.open_threads_json,
        row.pinned_checklist_json,
        row.rolled_up_at,
      );
  }

  getSession(sessionId: string): SessionSummaryRow | null {
    const row = this.db
      .prepare('SELECT * FROM session_summary WHERE session_id = ?')
      .get(sessionId) as SessionSummaryRow | undefined;
    return row ?? null;
  }

  /** Sessions whose stored `cwd` sits at or under `root`. Prefix-matches
   * so a project widget keyed on `repo_root` picks up sessions that ran
   * from any subdir of the repo, not just the repo root itself. Pass
   * `parentOnly: true` to exclude subagent rows (the project widget UI
   * counts parent sessions only). */
  sessionsForProject(
    root: string,
    opts: { limit?: number; parentOnly?: boolean } = {},
  ): SessionSummaryRow[] {
    const limit = opts.limit ?? 100;
    const kindClause = opts.parentOnly ? "AND kind = 'parent'" : '';
    return this.db
      .prepare(
        `SELECT * FROM session_summary
         WHERE (cwd = ? OR cwd LIKE ? || '/%') ${kindClause}
         ORDER BY started_at DESC LIMIT ?`,
      )
      .all(root, root, limit) as SessionSummaryRow[];
  }

  // ---- bootstrap_offsets ----

  getBootstrapOffset(filePath: string): number | null {
    const row = this.db
      .prepare('SELECT byte_offset FROM bootstrap_offsets WHERE file_path = ?')
      .get(filePath) as { byte_offset: number } | undefined;
    return row?.byte_offset ?? null;
  }

  setBootstrapOffset(filePath: string, offset: number, seenAt: number = Date.now() / 1000): void {
    this.db
      .prepare(
        `INSERT INTO bootstrap_offsets (file_path, byte_offset, last_seen_at)
         VALUES (?, ?, ?)
         ON CONFLICT(file_path) DO UPDATE SET
           byte_offset  = excluded.byte_offset,
           last_seen_at = excluded.last_seen_at`,
      )
      .run(filePath, offset, seenAt);
  }

  /** All `(file_path, byte_offset)` pairs the watcher has recorded.
   * Used at boot to hydrate the watcher's in-memory offset map. */
  allBootstrapOffsets(): Array<[string, number]> {
    const rows = this.db
      .prepare('SELECT file_path, byte_offset FROM bootstrap_offsets')
      .all() as Array<{ file_path: string; byte_offset: number }>;
    return rows.map((r) => [r.file_path, r.byte_offset]);
  }

  deleteBootstrapOffset(filePath: string): void {
    this.db.prepare('DELETE FROM bootstrap_offsets WHERE file_path = ?').run(filePath);
  }

  /** Wipe every offset. Called on monitor.start() so a server restart
   * forces the watcher to re-read the recent JSONL window — that's
   * what re-fills `panel.events[]` in memory, since events aren't
   * persisted as full payloads (only summaries in events_index). */
  clearAllBootstrapOffsets(): void {
    this.db.prepare('DELETE FROM bootstrap_offsets').run();
  }
}

// --- internal: row deserialization (boolean/null normalization) ---

interface RawIntentions {
  panel_id: string;
  pinned: number;
  wide: number;
  manual_order: number | null;
  user_mini: number;
  hidden_at: number | null;
  auto_mini_at: number | null;
  broken_out?: number;
  user_kept?: number;
  updated_at: number;
}

function deserializeIntentions(r: RawIntentions): IntentionsRow {
  return {
    panel_id: r.panel_id,
    pinned: !!r.pinned,
    wide: !!r.wide,
    manual_order: r.manual_order,
    user_mini: !!r.user_mini,
    hidden_at: r.hidden_at,
    auto_mini_at: r.auto_mini_at,
    broken_out: !!r.broken_out,
    user_kept: !!r.user_kept,
    updated_at: r.updated_at,
  };
}

interface RawPanel {
  id: string;
  kind: string;
  parent_panel_id: string | null;
  title: string;
  agent_type: string | null;
  account_label: string | null;
  status: string;
  started_at: number;
  last_event_at: number;
  status_changed_at: number;
  cwd: string | null;
  repo_root: string | null;
  theme_bg: string | null;
  theme_fg: string | null;
  binned_at: number | null;
  awaiting_input: number;
  ended: number;
  ended_provenance: string | null;
  manually_renamed: number;
  updated_at: number;
}

function deserializePanel(r: RawPanel): PanelRow {
  return {
    id: r.id,
    kind: r.kind as 'parent' | 'subagent',
    parent_panel_id: r.parent_panel_id,
    title: r.title,
    agent_type: r.agent_type,
    account_label: r.account_label,
    status: r.status as 'live' | 'done' | 'mini',
    started_at: r.started_at,
    last_event_at: r.last_event_at,
    status_changed_at: r.status_changed_at,
    cwd: r.cwd,
    repo_root: r.repo_root,
    theme_bg: r.theme_bg,
    theme_fg: r.theme_fg,
    binned_at: r.binned_at,
    awaiting_input: !!r.awaiting_input,
    ended: !!r.ended,
    ended_provenance: r.ended_provenance as PanelRow['ended_provenance'],
    manually_renamed: !!r.manually_renamed,
    updated_at: r.updated_at,
  };
}
