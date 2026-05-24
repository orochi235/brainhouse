/**
 * Read-only JSONL replay. Loads a transcript file from disk, parses it
 * into events, and synthesizes a `PanelDto` so the client can render it
 * through the regular PanelCard + view pipeline without touching the
 * live monitor / store / broadcast path.
 *
 * Side-effect surface: just `fs.readFile`. No store writes, no deltas,
 * no hook firings.
 */

import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { type Event, parseLine, type Raw } from './parser.js';
import type { Prefs } from './prefs.js';
import { resolveRoots } from './roots.js';
import type { PanelDto } from './session.js';

export interface ReplayPayload {
  panel: PanelDto;
  events: Event[];
  parseErrors: Array<{ lineNo: number; raw: string; error: string }>;
}

/** Resolve replay-allowed roots: configured transcript roots plus
 * `~/.claude/projects` (always included so a path that's outside the
 * user's configured set but in the canonical Claude Code location
 * still works). */
export function replayAllowedRoots(prefs: Prefs): string[] {
  const claudeProjects = path.join(os.homedir(), '.claude', 'projects');
  const roots = new Set<string>(resolveRoots(prefs));
  roots.add(claudeProjects);
  return [...roots].map((r) => path.resolve(r));
}

export function isReplayPathAllowed(absPath: string, allowed: string[]): boolean {
  const resolved = path.resolve(absPath);
  return allowed.some((root) => resolved === root || resolved.startsWith(root + path.sep));
}

export async function loadJsonlAsPanel(absPath: string): Promise<ReplayPayload> {
  const raw = await readFile(absPath, 'utf8');
  return parseJsonlToPanel(raw, absPath);
}

/** Pure parser used by both the path-based loader and the inline (drag-
 * dropped) variant. */
export function parseJsonlToPanel(contents: string, sourceLabel: string): ReplayPayload {
  const lines = contents.split('\n');
  const events: Event[] = [];
  const parseErrors: ReplayPayload['parseErrors'] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (!line.trim()) continue;
    try {
      const obj = JSON.parse(line) as Raw;
      const parsed = parseLine(obj);
      for (const ev of parsed) events.push(ev);
    } catch (err) {
      parseErrors.push({
        lineNo: i + 1,
        raw: line.slice(0, 200),
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const firstTs = parseTs(events[0]?.ts) ?? Date.now() / 1000;
  const lastTs = parseTs(events.at(-1)?.ts) ?? firstTs;

  const panel: PanelDto = {
    id: `replay:${sourceLabel}`,
    kind: 'parent',
    parent_panel_id: null,
    title: deriveTitle(sourceLabel),
    agent_type: null,
    task_description: null,
    account_label: null,
    status: 'done',
    started_at: firstTs,
    last_event_at: lastTs,
    status_changed_at: lastTs,
    event_count: events.length,
    cwd: null,
    theme: null,
    binned_at: null,
    awaiting_input: false,
    ended: true,
    ended_provenance: null,
    tokens: { input: 0, output: 0, cache_create: 0, cache_read: 0, model: null },
    context_size: 0,
    hook_overhead_tokens: 0,
  };

  return { panel, events, parseErrors };
}

function parseTs(ts: string | undefined): number | null {
  if (!ts) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms / 1000 : null;
}

function deriveTitle(sourceLabel: string): string {
  const base = sourceLabel.split('/').pop() ?? sourceLabel;
  return base.replace(/\.jsonl$/, '');
}
