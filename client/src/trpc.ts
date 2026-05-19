import type { AppRouter } from '@server/trpc.ts';
import { createTRPCClient, httpBatchLink, httpSubscriptionLink, splitLink } from '@trpc/client';

/**
 * Vanilla tRPC client with subscription support over SSE.
 *
 * Queries / mutations → httpBatchLink (POST /trpc/foo)
 * Subscriptions       → httpSubscriptionLink (SSE on GET /trpc/foo)
 */
export const trpc = createTRPCClient<AppRouter>({
  links: [
    splitLink({
      condition: (op) => op.type === 'subscription',
      true: httpSubscriptionLink({ url: '/trpc' }),
      false: httpBatchLink({ url: '/trpc' }),
    }),
  ],
});
