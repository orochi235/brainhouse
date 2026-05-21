/**
 * Startup self-check: warn when Claude Code hooks aren't wired up but the
 * user clearly has recent subagent activity in their transcripts.
 *
 * Without hooks, subagent completion falls back to a ~60s idle-timeout
 * heuristic. With hooks installed (via `brainhouse init`), Stop /
 * SubagentStop / Notification events arrive instantly.
 *
 * Detection is intentionally cheap and silent on any failure — this is a
 * one-shot startup nudge, never load-bearing.
 */

import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { defaultEventsDir } from './hookEvents.js';

const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60;

/** True iff `~/.brainhouse/events/` exists AND contains at least one .jsonl
 * file — proxy for "the dispatcher has fired at least once on this machine". */
export function hooksInstalled(eventsDir: string = defaultEventsDir()): boolean {
  try {
    if (!existsSync(eventsDir)) return false;
    const entries = readdirSync(eventsDir);
    return entries.some((name) => name.endsWith('.jsonl'));
  } catch {
    return false;
  }
}

/** Walk each root looking for any session dir with a `subagents/` child
 * that was modified within the last `withinSeconds`. The presence of that
 * directory is itself the subagent marker — Claude Code only creates it
 * when a Task has spawned. We avoid opening any JSONL files. */
export function hasRecentSubagents(
  roots: string[],
  now: number = Date.now(),
  withinSeconds: number = SEVEN_DAYS_SECONDS,
): boolean {
  const cutoffMs = now - withinSeconds * 1000;
  for (const root of roots) {
    try {
      if (!existsSync(root)) continue;
      const projects = readdirSync(root);
      for (const proj of projects) {
        const projPath = path.join(root, proj);
        let sessions: string[];
        try {
          sessions = readdirSync(projPath);
        } catch {
          continue;
        }
        for (const sess of sessions) {
          const subagentsDir = path.join(projPath, sess, 'subagents');
          try {
            const st = statSync(subagentsDir);
            if (!st.isDirectory()) continue;
            if (st.mtimeMs >= cutoffMs) return true;
            // mtime of the directory itself may lag; cheap secondary check:
            // any child .jsonl modified recently also counts.
            const children = readdirSync(subagentsDir);
            for (const c of children) {
              if (!c.endsWith('.jsonl')) continue;
              try {
                const cs = statSync(path.join(subagentsDir, c));
                if (cs.mtimeMs >= cutoffMs) return true;
              } catch {
                // ignore
              }
            }
          } catch {
            // no subagents dir on this session
          }
        }
      }
    } catch {
      // root unreadable; skip
    }
  }
  return false;
}

export interface OnboardingCheckResult {
  hooks: boolean;
  recentSubagents: boolean;
  shouldWarn: boolean;
}

export function checkOnboarding(
  roots: string[],
  eventsDir: string = defaultEventsDir(),
  now: number = Date.now(),
): OnboardingCheckResult {
  const hooks = hooksInstalled(eventsDir);
  const recentSubagents = !hooks && hasRecentSubagents(roots, now);
  return { hooks, recentSubagents, shouldWarn: !hooks && recentSubagents };
}

export const ONBOARDING_WARNING_LINES = [
  'Brainhouse hooks are not installed; subagent completion will fall back to idle-timeout (~60s).',
  'Run `brainhouse init` to enable instant Stop/SubagentStop/Notification signals.',
] as const;
