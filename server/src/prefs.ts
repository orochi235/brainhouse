/**
 * Persisted user preferences.
 *
 * Schema is defined here with Zod and is the single source of truth for both
 * shape and defaults. Stored as JSON on disk; loaded once at startup, mutated
 * via tRPC, written back atomically on every update.
 *
 * Path resolution:
 *   - $BRAINHOUSE_PREFS — explicit override (tests + dev)
 *   - $XDG_CONFIG_HOME/brainhouse/prefs.json if set
 *   - ~/.brainhouse/prefs.json otherwise
 */

import { existsSync, mkdirSync } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';

/**
 * Normalize a user-typed path: trim whitespace, expand `~`/`~/foo`, and
 * resolve to an absolute canonical form. This stops a typo like `~/.claude`
 * from being interpreted as the literal directory `./~/.claude` and stops
 * relative `.` paths from depending on the server's cwd.
 *
 * Refuses path traversal hijinks (a literal `..` segment in the input) so a
 * watch like `~/projects/../../etc` can't sneak past.
 */
function normalizePath(p: string): string {
  const trimmed = p.trim();
  if (!trimmed) throw new Error('path is empty');
  if (trimmed.split(path.sep).some((s) => s === '..')) {
    throw new Error(`refusing path with .. segment: ${p}`);
  }
  let expanded: string;
  if (trimmed === '~') expanded = os.homedir();
  else if (trimmed.startsWith('~/')) expanded = path.join(os.homedir(), trimmed.slice(2));
  else expanded = trimmed;
  return path.resolve(expanded);
}

export const RootSchema = z.object({
  /** Directory to watch for transcript JSONL files. Normalized at parse
   * time: `~` is expanded, relative paths become absolute, and `..` is
   * rejected. */
  path: z.string().transform(normalizePath),
  /** Short label shown in UI badges (e.g. "personal", "work"). */
  label: z.string().optional(),
  /** Hex color used to tint panels from this root. */
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{3,8}$/)
    .optional(),
});
export type Root = z.infer<typeof RootSchema>;

/**
 * Lifecycle timings, in seconds. All four govern the live → done → mini →
 * removed cascade. Defaults match SessionStore's built-in defaults.
 */
export const TimingsSchema = z.object({
  /** A live panel becomes `done` after this many idle seconds. */
  idleSeconds: z.number().int().positive().default(60),
  /** A `done` panel demotes to `mini` after this many seconds in `done`. */
  miniSeconds: z
    .number()
    .int()
    .positive()
    .default(5 * 60),
  /** A `mini` panel is fully removed after this many seconds in `mini`. */
  removeAfterSeconds: z
    .number()
    .int()
    .positive()
    .default(24 * 60 * 60),
  /** Server ticks the lifecycle this often (milliseconds). */
  tickIntervalMs: z.number().int().positive().default(5000),
});
export type Timings = z.infer<typeof TimingsSchema>;

/**
 * Workspace layout constraints. The integer-tiling layout picks cols/rows
 * each frame; `minCols`/`minRows` are floors it won't go below, and
 * `maxTilePx` caps how large a single cell can grow (so a lone panel on a
 * huge screen doesn't fill the whole viewport).
 */
export const WorkspaceSchema = z.object({
  minCols: z.number().int().min(1).default(1),
  minRows: z.number().int().min(1).default(1),
  /** Max width (and height) for one tile in grid units (cells across the
   * full grid). 0 = no cap; 1 = single cell; etc. Tiles never exceed the
   * full grid width regardless of this value. */
  maxTileSpan: z.number().int().min(0).default(0),
  /** When true, newly-arrived subagent panels are auto-routed into the
   * dock instead of taking a full slot in the grid. Useful for sessions
   * that fan out into many subagents. */
  spawnSubagentsMinimized: z.boolean().default(false),
  /** When true, a panel superseded by `/clear` or `/compact` is forced
   * to `mini` shortly after the supersede (`SUPERSEDE_MINI_DELAY_MS` in
   * monitor.ts) instead of waiting the normal done→mini interval. Set
   * false to keep cleared sessions visible in the grid until the regular
   * lifecycle ticks them down. */
  autoMinimizeOnClear: z.boolean().default(true),
  /** When true, the grid sorts panels so that panels sharing a worktree
   * land adjacent (and a labeled separator row precedes each group). Off
   * by default — useful when many in-flight worktrees blur the at-a-
   * glance scan, but otherwise interferes with manual layout. */
  groupByWorktree: z.boolean().default(false),
  /** Number of "guaranteed" grid slots the client tries to keep full.
   * Pinned + live unpinned panels claim slots first; remaining slots
   * pull from recent closed/idle panels via per-repo round-robin. Panels
   * beyond `slotCount` overflow into the tray. Pins are hard (always
   * primary), so if more than `slotCount` panels are pinned the grid
   * just grows. Set to 0 to disable the allocator (everything falls
   * back to status-based placement). */
  slotCount: z.number().int().min(0).default(4),
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Visual style / format toggles. Affect *how* messages render, not which
 * ones are visible — that's `MessagesSchema`. */
export const DisplaySchema = z.object({
  imessage: z.boolean().default(false),
  showElapsed: z.boolean().default(false),
  conversation: z.boolean().default(false),
  /** How much idle (`done`) panels fade. 1 = no dim, 0 = invisible.
   * Mini panels in the dock dim a touch more on top of this. */
  idleOpacity: z.number().min(0.2).max(1).default(0.5),
  /** Strength of the .hued background wash on panel title bars, 0–1.
   * Multiplied by 100 to drive a `color-mix` percentage. 0 = no tint,
   * 1 = the title bar is the .hued color. Default 0.14 matches the
   * legacy hardcoded value. */
  huedHeaderStrength: z.number().min(0).max(1).default(0.14),
  /** Reveal mode for the floating tool palette on live panels.
   *   - `hover`: hidden by default, faint affordance on panel hover,
   *     full reveal when the cursor approaches the top-right.
   *   - `always`: pinned visible. */
  toolPaletteDisplay: z.enum(['hover', 'always']).default('hover'),
  /** Bottom-row badge visibility. Each toggle hides its chip if false. */
  showSessionTime: z.boolean().default(true),
  showTokens: z.boolean().default(true),
  showContext: z.boolean().default(true),
  /** When true, a Stop hook runs `claude -p` after each assistant turn to
   * propose a panel title, using the user's own Claude CLI auth. The hook
   * decides whether to fire based on turn count + current title; the
   * server applies the new title only if it differs. */
  autoTitle: z.boolean().default(true),
});
export type Display = z.infer<typeof DisplaySchema>;

/** Per-message-type visibility. Each toggle defaults to `true` (visible); a
 * `false` hides that kind of view-item across all panels. */
export const MessagesSchema = z.object({
  thinking: z.boolean().default(true),
  system: z.boolean().default(true),
  meta: z.boolean().default(true),
  tools: z.boolean().default(true),
  fileChanges: z.boolean().default(true),
  opStrips: z.boolean().default(true),
});
export type Messages = z.infer<typeof MessagesSchema>;

/**
 * Editor deeplink template used when the user clicks a filename link in the
 * UI. `{path}` (URL-encoded), `{line}`, and `{col}` placeholders. Defaults
 * to Cursor; PrefsModal offers presets for VS Code, JetBrains IDEs, etc.
 * The placeholder substitution lives in `client/src/lib/filenameLinks.ts`.
 */
export const EditorSchema = z.object({
  urlTemplate: z.string().default('cursor://file/{path}:{line}'),
});
export type Editor = z.infer<typeof EditorSchema>;

export const StorageSchema = z.object({
  /** When true, brainhouse persists panel state + intentions + a windowed
   * event index to a local SQLite db at ~/.brainhouse/state.db (override
   * via BRAINHOUSE_DB). Lets a restart resume instantly instead of
   * replaying the last 30 min of JSONL. Default on; flip off if anything
   * misbehaves. */
  persistEnabled: z.boolean().default(true),
  /** How long per-event detail stays in the events_index table. Session
   * summaries are forever; per-event rows beyond this window are pruned
   * to keep DB footprint bounded. */
  eventsIndexRetentionDays: z.number().int().positive().default(30),
});
export type Storage = z.infer<typeof StorageSchema>;

/** Active nudges when a panel flips to `awaiting_input` (false → true).
 * These are *transitions*, not steady-state polling: a stuck-awaiting panel
 * doesn't keep retoasting. All channels off by default except the tab-title
 * flash, which has no permission cost. */
export const NotificationsSchema = z.object({
  /** Prepend "● " to `document.title` while any panel is awaiting input
   * AND the browser tab is hidden. Reverts as soon as either condition
   * clears. No permission prompt; safe default-on. */
  tabTitleFlash: z.boolean().default(true),
  /** Fire a native OS toast via the Notifications API on each false→true
   * transition. Clicking the toast focuses this tab and scrolls to the
   * panel. Requires `Notification.permission === 'granted'`; the client
   * triggers `requestPermission()` when the user flips this on. */
  browserNotification: z.boolean().default(false),
  /** Play a short synthesized chime on each transition. Off by default;
   * no asset (uses WebAudio so it works in dev with no bundled file). */
  audibleChime: z.boolean().default(false),
});
export type Notifications = z.infer<typeof NotificationsSchema>;

/** Developer tooling. When `enabled`, the UI surfaces debug affordances
 * (toolbar buttons, scenarios picker, preview triggers). Off by default;
 * intended for first-party use while building / dogfooding features. */
export const DebugSchema = z.object({
  enabled: z.boolean().default(false),
});
export type Debug = z.infer<typeof DebugSchema>;

export const PrefsSchema = z.object({
  /** Transcript roots to monitor. Empty array → fall back to platform defaults. */
  roots: z.array(RootSchema).default([]),

  display: DisplaySchema.default(DisplaySchema.parse({})),
  messages: MessagesSchema.default(MessagesSchema.parse({})),
  timings: TimingsSchema.default(TimingsSchema.parse({})),
  workspace: WorkspaceSchema.default(WorkspaceSchema.parse({})),
  storage: StorageSchema.default(StorageSchema.parse({})),
  editor: EditorSchema.default(EditorSchema.parse({})),
  notifications: NotificationsSchema.default(NotificationsSchema.parse({})),
  debug: DebugSchema.default(DebugSchema.parse({})),
});
export type Prefs = z.infer<typeof PrefsSchema>;

/** Default prefs (schema's own defaults, exposed for use as a fallback). */
export const DEFAULT_PREFS: Prefs = PrefsSchema.parse({});

function defaultPrefsPath(): string {
  if (process.env.BRAINHOUSE_PREFS) return path.resolve(process.env.BRAINHOUSE_PREFS);
  const xdg = process.env.XDG_CONFIG_HOME;
  const base = xdg ? path.join(xdg, 'brainhouse') : path.join(os.homedir(), '.brainhouse');
  return path.join(base, 'prefs.json');
}

export class PrefsStore {
  readonly filePath: string;
  private prefs: Prefs;

  constructor(filePath: string = defaultPrefsPath()) {
    this.filePath = filePath;
    this.prefs = { ...DEFAULT_PREFS };
  }

  /** Load from disk; on parse failure or missing file, keep defaults. */
  async load(): Promise<Prefs> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, 'utf8');
    } catch {
      // Missing file is fine — first run, leave defaults in place.
      return this.prefs;
    }
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      // Migration: autoTitle moved from `experimental.autoTitle` to
      // `display.autoTitle` (it's no longer experimental, and on by
      // default now). Carry over an explicit prior value before Zod
      // strips the old key.
      const exp = obj.experimental as { autoTitle?: unknown } | undefined;
      const disp = (obj.display as Record<string, unknown> | undefined) ?? {};
      if (exp && typeof exp.autoTitle === 'boolean' && disp.autoTitle === undefined) {
        obj.display = { ...disp, autoTitle: exp.autoTitle };
      }
      const parsed = PrefsSchema.parse(obj);
      this.prefs = parsed;
    } catch (_err) {
      // Malformed file: keep defaults, but don't overwrite the broken file
      // automatically — the user might want to repair it.
    }
    return this.prefs;
  }

  get(): Prefs {
    return this.prefs;
  }

  /** Replace prefs with the given partial; missing fields fall back to
   * current values. Validates the merged result and writes atomically. */
  async update(patch: Partial<Prefs>): Promise<Prefs> {
    const merged = PrefsSchema.parse({ ...this.prefs, ...patch });
    this.prefs = merged;
    await this.persist();
    return this.prefs;
  }

  private async persist(): Promise<void> {
    const dir = path.dirname(this.filePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(this.prefs, null, 2)}\n`, 'utf8');
    await rename(tmp, this.filePath);
  }
}
