import type { AppRouter } from '@server/trpc.ts';
import { createTRPCClient, httpBatchLink } from '@trpc/client';

// Vanilla tRPC client; we'll swap to @trpc/react-query bindings once we have
// actual queries/subscriptions to drive a real UI.
export const trpc = createTRPCClient<AppRouter>({
  links: [httpBatchLink({ url: '/trpc' })],
});
