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
import { simulateCounterSubagent, simulateMockSession } from './debug.js';
import type { TranscriptMonitor } from './monitor.js';
import type { Delta, PanelDto } from './session.js';

export interface AppContext {
  monitor: TranscriptMonitor;
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

  remove: t.procedure.input(z.object({ panelId: z.string() })).mutation(({ ctx, input }) => {
    const deltas = ctx.monitor.store.remove(input.panelId);
    for (const d of deltas) ctx.monitor.emitter.emit('delta', d);
    return { ok: true, deltas: deltas.length };
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

export type AppRouter = typeof appRouter;
