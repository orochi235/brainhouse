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
import { initTRPC } from '@trpc/server';
import { z } from 'zod';
import { simulateCounterSubagent, simulateMockSession, spawnSubagentIn } from './debug.js';
import { aggregateFlows } from './flows.js';
import { getScenario, listScenarios } from './scenarios.js';
import type { TranscriptMonitor } from './monitor.js';
import { PrefsSchema, type PrefsStore } from './prefs.js';
import { resolveRoots } from './roots.js';
import type { Delta, PanelDto } from './session.js';
import type { IntentionsRow, Store } from './store.js';

export interface AppContext {
  monitor: TranscriptMonitor;
  prefs: PrefsStore;
  /** Persistence layer. Nullable so prefs.storage.persistEnabled=false
   * (or test contexts) just skips the read/write paths. */
  store: Store | null;
}

const t = initTRPC.context<AppContext>().create();

const PanelStatus = z.enum(['live', 'done', 'mini']);

export type DeltaEvent =
  | { kind: 'snapshot'; panels: Array<PanelDto & { events: unknown[] }> }
  | { kind: 'delta'; delta: Delta };

export const appRouter = t.router({
  health: t.procedure.query(() => ({ ok: true, name: 'brainhouse', version: '0.0.1' })),

  snapshot: t.procedure.query(({ ctx }) => ({ panels: ctx.monitor.store.snapshot() })),

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
      if (
        before.storage.eventsIndexRetentionDays !== updated.storage.eventsIndexRetentionDays
      ) {
        ctx.monitor.setEventsIndexRetentionDays(updated.storage.eventsIndexRetentionDays);
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
            input.manual_order !== undefined ? input.manual_order : (existing?.manual_order ?? null),
          user_mini: input.user_mini ?? existing?.user_mini ?? false,
          hidden_at:
            input.hidden_at !== undefined ? input.hidden_at : (existing?.hidden_at ?? null),
          auto_mini_at:
            input.auto_mini_at !== undefined ? input.auto_mini_at : (existing?.auto_mini_at ?? null),
          broken_out: input.broken_out ?? existing?.broken_out ?? false,
          updated_at: Date.now() / 1000,
        });
        return { ok: true, persisted: true };
      }),
    clear: t.procedure.input(z.object({ panel_id: z.string() })).mutation(({ ctx, input }) => {
      ctx.store?.deleteIntentions(input.panel_id);
      return { ok: true };
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
      spawn: t.procedure
        .input(z.object({ key: z.string() }))
        .mutation(async ({ ctx, input }) => {
          const scenario = getScenario(input.key);
          if (!scenario) throw new Error(`Unknown scenario: ${input.key}`);
          const { sessionId } = await scenario.run(ctx.monitor, {});
          return { sessionId };
        }),
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
