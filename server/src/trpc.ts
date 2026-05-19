import { initTRPC } from '@trpc/server';

const t = initTRPC.create();

export const router = t.router;
export const publicProcedure = t.procedure;

// Hello-world router. Real procedures (snapshot, restore, remove, subscribe-to-deltas, ...)
// land as we port the pensieve modules.
export const appRouter = router({
  health: publicProcedure.query(() => ({ ok: true, name: 'brainhouse', version: '0.0.1' })),
});

export type AppRouter = typeof appRouter;
