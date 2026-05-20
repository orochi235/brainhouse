import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@server': resolve(__dirname, '../server/src'),
    },
  },
  test: {
    // happy-dom for all client tests so hooks + components can render.
    // Picked over jsdom because jsdom 29's WebStorage is finicky to enable
    // and happy-dom is faster anyway. Pure-logic tests pay a small setup
    // cost but don't otherwise care.
    environment: 'happy-dom',
    environmentOptions: {
      'happy-dom': {
        url: 'http://localhost/',
      },
    },
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
  },
});
