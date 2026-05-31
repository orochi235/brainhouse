/**
 * Project widgets — dashboard cards keyed to a repo rather than a single
 * Claude Code session.
 *
 * Shape: same dimensions as a session `PanelCard`. Content: project
 * metadata header (cwd, account, theme), aggregate stats (sessions,
 * files, tokens), and a list of recent parent sessions for inspection.
 *
 * Lifecycle: auto-derived from observed panels — any cwd that's been
 * seen produces one widget keyed by `deriveWorktree(cwd).repo` (or the
 * cwd's last segment when it isn't a worktree). Worktrees of the same
 * repo collapse to one widget. Widgets are *not* part of the slot
 * allocator — they render unconditionally for every known project (or
 * every non-excluded one once an exclusion pref lands). The grid layout
 * counts them as additional cells alongside session cards.
 */

import type { PanelDto } from '@server/session.ts';
import type { PanelState } from '../useDeltaStream.ts';
import { deriveWorktree } from './worktree.ts';

export interface ProjectWidget {
  /** Pseudo-id of the form `project:<repo>`. Distinct from UUID-shaped
   * session ids; safe to share namespace with `panel_id` in the
   * intentions table. */
  id: string;
  kind: 'project';
  repo: string;
  /** A representative cwd for the project — used for `.hued` theme
   * derivation. Picked as the cwd of the most-recently-active session
   * in the project so theming follows the user's actual checkout. */
  cwd: string;
  /** Wall-clock seconds of the project's most recent session activity.
   * Used for ordering widgets among themselves; not consulted by the
   * slot allocator. */
  last_event_at: number;
}

export interface ProjectRollupSessionRow {
  id: string;
  title: string;
  status: PanelState['status'];
  last_event_at: number;
  started_at: number;
  awaiting_input: boolean;
  ended: boolean;
  /** Input-equivalent token total for the session. */
  tokens: number;
}

export interface ProjectRollup {
  widget: ProjectWidget;
  /** Account label if multiple accounts/roots are configured; null if
   * the only-account case applies (header omits the chip). */
  account_label: string | null;
  /** `.hued` theme stamped on the most-recent panel for this project.
   * Null when the user hasn't configured a `.hued` file. */
  theme: PanelDto['theme'];
  /** Count of *parent* sessions seen for this project (subagents
   * excluded). */
  sessionCount: number;
  /** Unique file paths touched across all panels in this project, derived
   * from `Read`/`Edit`/`Write`/`MultiEdit` tool_use events. Best-effort —
   * v0 walks loaded events, so reaped panels' files don't count. */
  fileCount: number;
  /** Sum of input-equivalent tokens across all panels in this project. */
  totalTokens: number;
  /** Most-recently-active parent sessions, capped. Each entry can be
   * clicked to surface the underlying panel. */
  recentSessions: ProjectRollupSessionRow[];
}

const FILE_TOOL_NAMES = new Set(['Read', 'Edit', 'Write', 'MultiEdit']);
const RECENT_SESSIONS_CAP = 8;

/** Project-widget aggregate status — collapses every session in the
 * rollup into one of the canonical panel statuses for use with
 * `<StatusLight>` + the existing `.status-*` CSS cascade.
 *
 * Priority: live > done > mini. Awaiting-input and pending (waiting on
 * model) are surfaced separately as booleans so callers can decorate
 * the wrapper with `.awaiting-input` / `.waiting` like a session
 * article does. `ended` is true only when every session has ended.
 */
export function aggregateProjectStatus(rollup: ProjectRollup): {
  status: PanelState['status'];
  ended: boolean;
  awaitingInput: boolean;
} {
  const rows = rollup.recentSessions;
  if (rows.length === 0) {
    return { status: 'mini', ended: false, awaitingInput: false };
  }
  let live = false;
  let done = false;
  let mini = false;
  let awaitingInput = false;
  let allEnded = true;
  for (const r of rows) {
    if (r.status === 'live') live = true;
    else if (r.status === 'done') done = true;
    else if (r.status === 'mini') mini = true;
    if (r.awaiting_input) awaitingInput = true;
    if (!r.ended) allEnded = false;
  }
  const status: PanelState['status'] = live ? 'live' : done ? 'done' : mini ? 'mini' : 'done';
  return { status, ended: allEnded, awaitingInput };
}

const NO_REPO_KEY = '__no_repo__';

/** Build the widget key for a panel. Priority:
 *
 *   1. `repo_root` — stamped server-side by walking up the cwd looking
 *      for `.git`. Authoritative when present: every session in the
 *      same checkout collapses to one widget regardless of which
 *      subdirectory the user `cd`'d into.
 *   2. Worktree-pattern match on `cwd` (`.../<repo>/.claude/worktrees/foo`).
 *      Pre-`repo_root` fallback; still useful when the worktree dir
 *      isn't itself a `.git` checkout the walk would find.
 *   3. `cwd`'s last segment. Coarse but at least keeps non-repo
 *      scratch dirs visible. Will fragment under subdir use — that's
 *      what `repo_root` exists to fix.
 */
function projectKeyForPanel(panel: {
  cwd: string | null;
  repo_root?: string | null;
}): { repo: string; key: string } | null {
  if (panel.repo_root) {
    const repo = panel.repo_root.split('/').filter(Boolean).pop();
    if (repo) return { repo, key: panel.repo_root };
  }
  const cwd = panel.cwd;
  if (!cwd) return null;
  const wt = deriveWorktree(cwd);
  if (wt) return { repo: wt.repo, key: wt.repo };
  const seg = cwd.split('/').filter(Boolean).pop();
  if (!seg) return null;
  return { repo: seg, key: seg };
}

/**
 * Input-equivalent total, matching the per-panel chip weighting in
 * `tokenCost.ts`: input ×1, cache_create ×1.25, cache_read ×0.1,
 * output ×5. Coarse but consistent with what the UI shows elsewhere.
 */
function inputEquivalent(t: PanelState['tokens']): number {
  return t.input * 1 + t.cache_create * 1.25 + t.cache_read * 0.1 + t.output * 5;
}

function filesTouched(events: PanelState['events']): Set<string> {
  const paths = new Set<string>();
  for (const e of events) {
    if (e.kind !== 'tool_use') continue;
    const payload = e.payload as { name?: string; input?: { file_path?: string } };
    if (!payload.name || !FILE_TOOL_NAMES.has(payload.name)) continue;
    const path = payload.input?.file_path;
    if (typeof path === 'string' && path) paths.add(path);
  }
  return paths;
}

/**
 * One widget per observed project. Most-recent project first.
 */
export function deriveProjectWidgets(panels: Map<string, PanelState>): ProjectWidget[] {
  const byKey = new Map<string, { repo: string; cwd: string; last_event_at: number }>();
  for (const p of panels.values()) {
    const proj = projectKeyForPanel(p);
    if (!proj || proj.key === NO_REPO_KEY) continue;
    const prior = byKey.get(proj.key);
    if (!prior || p.last_event_at > prior.last_event_at) {
      byKey.set(proj.key, {
        repo: proj.repo,
        cwd: p.repo_root ?? p.cwd ?? '',
        last_event_at: p.last_event_at,
      });
    }
  }
  const widgets: ProjectWidget[] = [];
  for (const [key, info] of byKey) {
    widgets.push({
      id: `project:${key}`,
      kind: 'project',
      repo: info.repo,
      cwd: info.cwd,
      last_event_at: info.last_event_at,
    });
  }
  widgets.sort((a, b) => b.last_event_at - a.last_event_at);
  return widgets;
}

/**
 * Walk panels once and produce a rollup keyed by project key. Returns
 * rollups in the same order as `deriveProjectWidgets` (most-recent
 * project first).
 */
export function buildProjectRollups(panels: Map<string, PanelState>): ProjectRollup[] {
  type Acc = {
    repo: string;
    cwd: string;
    last_event_at: number;
    theme: PanelDto['theme'];
    account_label: string | null;
    sessionCount: number;
    totalTokens: number;
    files: Set<string>;
    sessions: ProjectRollupSessionRow[];
  };
  const byKey = new Map<string, Acc>();

  for (const p of panels.values()) {
    const proj = projectKeyForPanel(p);
    if (!proj) continue;
    let acc = byKey.get(proj.key);
    if (!acc) {
      acc = {
        repo: proj.repo,
        cwd: p.cwd ?? '',
        last_event_at: 0,
        theme: null,
        account_label: null,
        sessionCount: 0,
        totalTokens: 0,
        files: new Set(),
        sessions: [],
      };
      byKey.set(proj.key, acc);
    }
    // Latest-wins for representative metadata (cwd, theme, account_label).
    // Prefer `repo_root` over `cwd` when available so the widget header
    // names the project, not whichever subdir the latest session
    // happened to run from.
    if (p.last_event_at > acc.last_event_at) {
      acc.last_event_at = p.last_event_at;
      const rep = p.repo_root ?? p.cwd;
      if (rep) acc.cwd = rep;
      if (p.theme) acc.theme = p.theme;
      if (p.account_label) acc.account_label = p.account_label;
    }
    acc.totalTokens += inputEquivalent(p.tokens);
    for (const f of filesTouched(p.events)) acc.files.add(f);
    if (p.kind === 'parent') {
      acc.sessionCount += 1;
      acc.sessions.push({
        id: p.id,
        title: p.title,
        status: p.status,
        last_event_at: p.last_event_at,
        started_at: p.started_at,
        awaiting_input: p.awaiting_input,
        ended: p.ended,
        tokens: inputEquivalent(p.tokens),
      });
    }
  }

  const rollups: ProjectRollup[] = [];
  for (const [key, acc] of byKey) {
    acc.sessions.sort((a, b) => b.last_event_at - a.last_event_at);
    rollups.push({
      widget: {
        id: `project:${key}`,
        kind: 'project',
        repo: acc.repo,
        cwd: acc.cwd,
        last_event_at: acc.last_event_at,
      },
      account_label: acc.account_label,
      theme: acc.theme,
      sessionCount: acc.sessionCount,
      fileCount: acc.files.size,
      totalTokens: acc.totalTokens,
      recentSessions: acc.sessions.slice(0, RECENT_SESSIONS_CAP),
    });
  }
  rollups.sort((a, b) => b.widget.last_event_at - a.widget.last_event_at);
  return rollups;
}
