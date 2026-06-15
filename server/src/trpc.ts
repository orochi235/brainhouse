/**
 * tRPC API surface. Procedures pull the monitor singleton off ctx; the
 * fastify adapter calls createContext per-request.
 *
 * Procedures:
 *   health         — sanity check
 *   snapshot       — full panel list with events (for initial page hydration)
 *   forceStatus    — debug "× close" button (live → done, etc.)
 *   restore        — drag-from-tray (any → done)
 *   remove         — trash can in the mini tray (permanent delete)
 *   deltas         — subscription; emits {kind: 'snapshot'} then a stream of
 *                    {kind: 'delta', delta} messages forever
 */

import { type EventEmitter, on } from 'node:events';
import { readFileSync } from 'node:fs';
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { simulateCounterSubagent, simulateMockSession, spawnSubagentIn } from './debug.js';
import { collectDebugState } from './debugState.js';
import { aggregateFlows } from './flows.js';
import { sliceHistory } from './history.js';
import type { TranscriptMonitor } from './monitor.js';
import { PrefsSchema, type PrefsStore } from './prefs.js';
import type { ProcessTracker, ProcessRow } from './processes/index.js';
import {
  isReplayPathAllowed,
  loadJsonlAsPanel,
  parseJsonlToPanel,
  replayAllowedRoots,
} from './replay.js';
import { resolveRoots } from './roots.js';
import { getScenario, listScenarios } from './scenarios.js';
import type { Delta, PanelDto } from './session.js';
import type { IntentionsRow, Store } from './store.js';

export interface AppContext {
  monitor: TranscriptMonitor;
  prefs: PrefsStore;
  /** Persistence layer. Nullable so prefs.storage.persistEnabled=false
   * (or test contexts) just skips the read/write paths. */
  store: Store | null;
  /** Process tracker. Nullable so tests / contexts without a tracker
   * just return empty subscriptions and 4xx on `kill`. */
  tracker: ProcessTracker | null;
}

export type ProcessDelta =
  | { op: 'process_upsert'; process: ProcessRow }
  | { op: 'process_delete'; process_id: string }
  | { op: 'process_ports'; process_id: string; ports: ProcessRow['ports'] };

export type ProcessEvent =
  | { kind: 'snapshot'; rows: ProcessRow[] }
  | { kind: 'delta'; delta: ProcessDelta };

const t = initTRPC.context<AppContext>().create();

const PanelStatus = z.enum(['live', 'done', 'mini']);

export type DeltaEvent =
  | { kind: 'snapshot'; panels: Array<PanelDto & { events: unknown[] }> }
  | { kind: 'delta'; delta: Delta };

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true, name: 'brainhouse', version: '0.0.1' })),

  snapshot: t.procedure.query(({ ctx }) => ({ panels: ctx.monitor.store.snapshot() })),

  eventByUuid: t.procedure
    .input(z.object({ panelId: z.string(), uuid: z.string() }))
    .query(({ ctx, input }) => ({
      event: ctx.monitor.store.eventByUuid(input.panelId, input.uuid),
    })),

  forceStatus: t.procedure
    .input(z.object({ panelId: z.string(), status: PanelStatus }))
    .mutation(({ ctx, input }) => {
      const deltas = ctx.monitor.store.forceStatus(input.panelId, input.status);
      for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
      return { ok: true, deltas: deltas.length };
    }),

  restore: t.procedure.input(z.object({ panelId: z.string() })).mutation(({ ctx, input }) => {
    const deltas = ctx.monitor.store.forceStatus(input.panelId, 'done');
    for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
    return { ok: true, deltas: deltas.length };
  }),

  /** Soft-delete: move panel to the trash bin (reversible via bin.restore). */
  remove: t.procedure.input(z.object({ panelId: z.string() })).mutation(({ ctx, input }) => {
    const deltas = ctx.monitor.store.bin(input.panelId);
    for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
    return { ok: true, deltas: deltas.length };
  }),

  processes: t.router({
    subscribe: t.procedure.subscription(async function* ({
      ctx,
      signal,
    }): AsyncGenerator<ProcessEvent> {
      const tracker = ctx.tracker;
      if (!tracker) return;
      tracker.addSubscriber();
      // Buffered queue + waker so a single async generator can fan in
      // three event names without juggling multiple AsyncIterators.
      const queue: ProcessEvent[] = [];
      let wake: (() => void) | null = null;
      const notify = () => {
        if (wake) {
          const w = wake;
          wake = null;
          w();
        }
      };
      const onUpsert = (r: ProcessRow) => {
        queue.push({ kind: 'delta', delta: { op: 'process_upsert', process: r } });
        notify();
      };
      const onDelete = (id: string) => {
        queue.push({ kind: 'delta', delta: { op: 'process_delete', process_id: id } });
        notify();
      };
      const onPorts = (p: { process_id: string; ports: ProcessRow['ports'] }) => {
        queue.push({
          kind: 'delta',
          delta: { op: 'process_ports', process_id: p.process_id, ports: p.ports },
        });
        notify();
      };
      tracker.on('upsert', onUpsert);
      tracker.on('delete', onDelete);
      tracker.on('ports', onPorts);
      const onAbort = () => notify();
      signal?.addEventListener('abort', onAbort);
      try {
        yield { kind: 'snapshot', rows: tracker.snapshot() };
        while (!signal?.aborted) {
          while (queue.length) yield queue.shift()!;
          if (signal?.aborted) break;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      } finally {
        tracker.off('upsert', onUpsert);
        tracker.off('delete', onDelete);
        tracker.off('ports', onPorts);
        signal?.removeEventListener('abort', onAbort);
        tracker.removeSubscriber();
      }
    }),
    kill: t.procedure
      .input(z.object({ process_id: z.string() }))
      .mutation(async ({ ctx, input }) => {
        if (!ctx.tracker) throw new Error('tracker not configured');
        await ctx.tracker.kill(input.process_id);
        return { ok: true };
      }),
    /** Scan the session's transcript JSONL from the end and return the
     * tail of the most recent tool_result whose body contains `bash_id`.
     * Returns the empty string when the tracker isn't configured, the row
     * has no `bash_id`, or no matching tool_result has been written yet. */
    tailStdout: t.procedure
      .input(z.object({ process_id: z.string(), lines: z.number().default(40) }))
      .query(({ ctx, input }) => {
        if (!ctx.tracker) return { content: '' };
        const row = ctx.tracker.snapshot().find((r) => r.process_id === input.process_id);
        if (!row?.bash_id || !row.session_id) return { content: '' };
        const transcriptPath = ctx.tracker.getTranscriptPath(row.session_id);
        if (!transcriptPath) return { content: '' };
        return { content: tailBashOutput(transcriptPath, row.bash_id, input.lines) };
      }),
  }),

  bin: t.router({
    list: t.procedure.query(({ ctx }) => ({ panels: ctx.monitor.store.binnedDtos() })),
    restore: t.procedure.input(z.object({ panelId: z.string() })).mutation(({ ctx, input }) => {
      const deltas = ctx.monitor.store.unbin(input.panelId);
      for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
      return { ok: true, deltas: deltas.length };
    }),
    purge: t.procedure.input(z.object({ panelId: z.string() })).mutation(({ ctx, input }) => {
      const deltas = ctx.monitor.store.remove(input.panelId);
      for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
      return { ok: true, deltas: deltas.length };
    }),
  }),

  prefs: t.router({
    get: t.procedure.query(({ ctx }) => ctx.prefs.get()),
    update: t.procedure.input(PrefsSchema.partial()).mutation(async ({ ctx, input }) => {
      const before = ctx.prefs.get();
      const updated = await ctx.prefs.update(input);
      // Hot-swap the watcher when the resolved root list changes. We
      // compare the *resolved* list (env > prefs > defaults) rather than
      // just `input.roots` so swapping in an empty list falls back to
      // defaults instead of silently shutting the watcher off.
      const beforeRoots = resolveRoots(before);
      const afterRoots = resolveRoots(updated);
      if (!sameList(beforeRoots, afterRoots) || rootLabelsChanged(before.roots, updated.roots)) {
        await ctx.monitor.setRoots(afterRoots, updated.roots);
      }
      // Hot-swap lifecycle timings if any changed. The next `tick()` picks
      // up the new values; reschedule the tick interval if it changed too.
      const a = before.timings;
      const b = updated.timings;
      if (
        a.idleSeconds !== b.idleSeconds ||
        a.miniSeconds !== b.miniSeconds ||
        a.removeAfterSeconds !== b.removeAfterSeconds ||
        a.tickIntervalMs !== b.tickIntervalMs
      ) {
        ctx.monitor.setTimings(b);
      }
      // Hot-swap events_index retention; takes effect immediately + on the
      // next daily prune. No restart needed.
      if (before.storage.eventsIndexRetentionDays !== updated.storage.eventsIndexRetentionDays) {
        ctx.monitor.setEventsIndexRetentionDays(updated.storage.eventsIndexRetentionDays);
      }
      if (before.workspace.autoMinimizeOnClear !== updated.workspace.autoMinimizeOnClear) {
        ctx.monitor.setAutoMinimizeOnClear(updated.workspace.autoMinimizeOnClear);
      }
      return updated;
    }),
  }),

  /** Per-panel UI intentions (pin / wide / manual_order / user_mini /
   * hidden_at / auto_mini_at). Lives in `intentions` table; survives
   * server restarts when prefs.storage.persistEnabled is true. */
  intentions: t.router({
    all: t.procedure.query(({ ctx }): IntentionsRow[] => ctx.store?.allIntentions() ?? []),
    upsert: t.procedure
      .input(
        z.object({
          panel_id: z.string(),
          pinned: z.boolean().optional(),
          wide: z.boolean().optional(),
          manual_order: z.number().int().nullable().optional(),
          user_mini: z.boolean().optional(),
          hidden_at: z.number().nullable().optional(),
          auto_mini_at: z.number().nullable().optional(),
          broken_out: z.boolean().optional(),
          user_kept: z.boolean().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        if (!ctx.store) return { ok: false, persisted: false };
        // Merge with existing so partial patches don't clobber other fields.
        const existing = ctx.store.getIntentions(input.panel_id);
        ctx.store.upsertIntentions({
          panel_id: input.panel_id,
          pinned: input.pinned ?? existing?.pinned ?? false,
          wide: input.wide ?? existing?.wide ?? false,
          manual_order:
            input.manual_order !== undefined
              ? input.manual_order
              : (existing?.manual_order ?? null),
          user_mini: input.user_mini ?? existing?.user_mini ?? false,
          hidden_at:
            input.hidden_at !== undefined ? input.hidden_at : (existing?.hidden_at ?? null),
          auto_mini_at:
            input.auto_mini_at !== undefined
              ? input.auto_mini_at
              : (existing?.auto_mini_at ?? null),
          broken_out: input.broken_out ?? existing?.broken_out ?? false,
          user_kept:
            input.user_kept ?? existing?.user_kept ?? false,
          updated_at: Date.now() / 1000,
        });
        return { ok: true, persisted: true };
      }),
    clear: t.procedure.input(z.object({ panel_id: z.string() })).mutation(({ ctx, input }) => {
      ctx.store?.deleteIntentions(input.panel_id);
      return { ok: true };
    }),
  }),

  /** Sessions belonging to a project, read from the persistent
   * `session_summary` table. Used by `ProjectWidgetCard` so the widget's
   * session list reflects everything that's ever run under the project
   * — not just the handful of panels still in client memory after the
   * mini→removed reap. Prefix-matches `cwd`, so a `root` of `/repo`
   * picks up sessions that ran from any subdir of the repo. */
  sessions: t.router({
    forProject: t.procedure
      .input(
        z.object({
          root: z.string().min(1),
          limit: z.number().int().positive().max(500).default(100),
          parentOnly: z.boolean().default(true),
        }),
      )
      .query(({ ctx, input }) => {
        if (!ctx.store) return { sessions: [] };
        return {
          sessions: ctx.store.sessionsForProject(input.root, {
            limit: input.limit,
            parentOnly: input.parentOnly,
          }),
        };
      }),
  }),

  /** Cross-session event-type frequency counters. Counts every event the
   * monitor has ingested since the DB was created, broken down by (kind,
   * subkey). Used by the debug StatsModal to surface "what are we actually
   * seeing in the wild." */
  eventStats: t.procedure.query(({ ctx }) => ctx.store?.getEventStats() ?? []),

  /** Cross-session "flows" sankey: bucket events by ordinal position in
   * their session, then count consecutive (K,X) → (K+1,Y) transitions
   * over the last `days` (default 30). Returns nodes + links shaped for
   * d3-sankey on the client. Empty result when persistence is disabled. */
  flows: t.router({
    aggregate: t.procedure
      .input(z.object({ days: z.number().int().positive().max(365).default(30) }).optional())
      .query(({ ctx, input }) => {
        if (!ctx.store) return { nodes: [], links: [] };
        return aggregateFlows(ctx.store, input?.days ?? 30);
      }),
  }),

  debug: t.router({
    spawnMock: t.procedure.mutation(async ({ ctx }) => {
      const sessionId = await simulateMockSession(ctx.monitor);
      return { sessionId };
    }),
    spawnCounter: t.procedure
      .input(z.object({ stopAt: z.number().int().positive().max(1000).default(100) }).optional())
      .mutation(async ({ ctx, input }) => {
        const { sessionId, agentId } = await simulateCounterSubagent(
          ctx.monitor,
          input?.stopAt ?? 100,
        );
        return { sessionId, agentId };
      }),
    scenarios: t.router({
      list: t.procedure.query(() => listScenarios()),
      spawn: t.procedure.input(z.object({ key: z.string() })).mutation(async ({ ctx, input }) => {
        const scenario = getScenario(input.key);
        if (!scenario) throw new Error(`Unknown scenario: ${input.key}`);
        const { sessionId } = await scenario.run(ctx.monitor, {});
        return { sessionId };
      }),
    }),
    /** Wipe a panel's in-memory + persisted state and re-read its JSONL
     * from byte 0 so the current set of transforms / derivation rules
     * gets re-applied. Cascades to subagents (and to subagent JSONLs
     * on disk that don't have a panel yet). Dev-only affordance. */
    rebuildPanel: t.procedure
      .input(z.object({ panelId: z.string() }))
      .mutation(async ({ ctx, input }) => {
        const files = await ctx.monitor.rebuildPanel(input.panelId);
        return { panelId: input.panelId, filesRereadCount: files.length };
      }),
    spawnSubagentIn: t.procedure
      .input(
        z.object({
          sessionId: z.string(),
          stopAt: z.number().int().positive().max(200).default(20),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        const agentId = await spawnSubagentIn(ctx.monitor, input.sessionId, input.stopAt);
        return { sessionId: input.sessionId, agentId };
      }),
    /** Fires the same three auto-title visibility effects (title flash,
     * toast, inline meta breadcrumb) without involving `claude -p`. The
     * `title` input is the demo string the panel will flash to; omit it
     * to use a timestamped default. */
    /** Read a transcript JSONL from disk and return a synthesized
     * PanelDto + parsed events. The path must live under one of the
     * configured roots or under `~/.claude/projects`. Read-only: never
     * touches the store or broadcaster. Used by the replay debug view. */
    replayJsonl: t.procedure
      .input(z.object({ path: z.string() }))
      .query(async ({ ctx, input }) => {
        const allowed = replayAllowedRoots(ctx.prefs.get());
        if (!isReplayPathAllowed(input.path, allowed)) {
          throw new Error(`Path not in replay allowlist: ${input.path}`);
        }
        return loadJsonlAsPanel(input.path);
      }),
    /** Same as `replayJsonl` but takes the JSONL contents inline. Used
     * by drag-and-drop in the browser, where the absolute path isn't
     * exposed to the page. No allowlist gate — the contents are
     * already in the client's possession. */
    replayJsonlInline: t.procedure
      .input(z.object({ contents: z.string(), label: z.string().optional() }))
      .query(({ input }) => parseJsonlToPanel(input.contents, input.label ?? 'inline')),
    previewAutoTitle: t.procedure
      .input(
        z.object({
          panelId: z.string(),
          title: z.string().optional(),
        }),
      )
      .mutation(({ ctx, input }) => {
        const proposed = input.title?.trim() || `Demo title ${new Date().toLocaleTimeString()}`;
        // Route through the auto_title hook event path so observers (incl.
        // the broadcaster's theme-load side effect) see the same shape.
        ctx.monitor.applyHookEvent({
          kind: 'auto_title',
          session_id: input.panelId,
          title: proposed,
          ts: Date.now() / 1000,
        });
        return { title: proposed };
      }),
  }),

  /** Unfiltered dump of the running model: every panel in the SessionStore
   * map (incl. binned), file-vs-panel reconciliation per root, the
   * bootstrap_offsets table, and current delta subscriber count. Used by
   * the `/debug` tile to surface state independent of any rendering
   * filters. Not part of the normal client/server contract. */
  debugState: t.procedure.query(({ ctx }) => collectDebugState(ctx.monitor)),

  /** Lazy scroll-back: re-parse a panel's transcript JSONL and return the
   * `limit` events immediately before `beforeUuid`. Read-only; the full
   * history lives in the JSONL, not the in-memory live window. */
  panelHistory: t.procedure
    .input(
      z.object({
        panelId: z.string(),
        beforeUuid: z.string(),
        limit: z.number().int().positive().max(2000).default(500),
      }),
    )
    .query(async ({ ctx, input }) => {
      const file = ctx.monitor.sourceFileForPanel(input.panelId);
      if (!file) return { events: [], hasMore: false };
      const { events } = await loadJsonlAsPanel(file);
      return sliceHistory(events, input.beforeUuid, input.limit);
    }),

  deltas: t.procedure.subscription(async function* ({ ctx, signal }) {
    // Initial snapshot so a fresh subscriber doesn't have to make a separate
    // query — same pattern as brainhouse's WS hello message.
    yield { kind: 'snapshot', panels: ctx.monitor.store.snapshot() } satisfies DeltaEvent;
    const iter = on(ctx.monitor.emitter as EventEmitter, 'delta', { signal });
    for await (const [delta] of iter) {
      yield { kind: 'delta', delta: delta as Delta } satisfies DeltaEvent;
    }
  }),
});

/** Walk a transcript JSONL backwards looking for the most recent
 * `tool_result` whose body mentions `bashId`. Returns the trailing
 * `lines` lines of that body. Best-effort: file-missing or malformed
 * lines are swallowed and yield an empty string. Exported for test. */
export function tailBashOutput(transcriptPath: string, bashId: string, lines: number): string {
  try {
    const raw = readFileSync(transcriptPath, 'utf8').split('\n');
    for (let i = raw.length - 1; i >= 0; i--) {
      const line = raw[i];
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.type === 'user' && Array.isArray(rec.message?.content)) {
          for (const c of rec.message.content) {
            if (c.type === 'tool_result' && c.content) {
              const body = typeof c.content === 'string' ? c.content : JSON.stringify(c.content);
              if (body.includes(bashId)) {
                return body.split('\n').slice(-lines).join('\n');
              }
            }
          }
        }
      } catch {
        /* skip malformed line */
      }
    }
  } catch {
    /* file missing */
  }
  return '';
}

function sameList(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function rootLabelsChanged(
  a: Array<{ path: string; label?: string }>,
  b: Array<{ path: string; label?: string }>,
): boolean {
  const byPath = (xs: typeof a) => new Map(xs.map((x) => [x.path, x.label ?? '']));
  const m = byPath(a);
  const n = byPath(b);
  if (m.size !== n.size) return true;
  for (const [k, v] of m) if (n.get(k) !== v) return true;
  return false;
}

export type AppRouter = typeof appRouter;
