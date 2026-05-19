import { describe, expect, it } from 'vitest';
import { appRouter } from './trpc.js';

describe('appRouter', () => {
  it('exposes a health query', async () => {
    const caller = appRouter.createCaller({});
    const result = await caller.health();
    expect(result.ok).toBe(true);
    expect(result.name).toBe('brainhouse');
  });
});
