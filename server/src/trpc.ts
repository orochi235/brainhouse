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
import type { TranscriptMonitor } from './monitor.js';
import { PrefsSchema, type PrefsStore } from './prefs.js';
import { resolveRoots } from './roots.js';
import type { Delta, PanelDto } from './session.js';

export interface AppContext {
  monitor: TranscriptMonitor;
  prefs: PrefsStore;
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
      return updated;
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
  }),

  deltas: t.procedure.subscription(async function* ({ ctx, signal }) {
    // Initial snapshot so a fresh subscriber doesn't have to make a separate
    // query — same pattern as pensieve's WS hello message.
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
