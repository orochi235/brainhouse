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
});
export type Workspace = z.infer<typeof WorkspaceSchema>;

/** Visual style / format toggles. Affect *how* messages render, not which
 * ones are visible — that's `MessagesSchema`. */
export const DisplaySchema = z.object({
  imessage: z.boolean().default(false),
  showElapsed: z.boolean().default(false),
  conversation: z.boolean().default(false),
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

export const PrefsSchema = z.object({
  /** Transcript roots to monitor. Empty array → fall back to platform defaults. */
  roots: z.array(RootSchema).default([]),

  display: DisplaySchema.default(DisplaySchema.parse({})),
  messages: MessagesSchema.default(MessagesSchema.parse({})),
  timings: TimingsSchema.default(TimingsSchema.parse({})),
  workspace: WorkspaceSchema.default(WorkspaceSchema.parse({})),
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
      const parsed = PrefsSchema.parse(JSON.parse(raw));
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
