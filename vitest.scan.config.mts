import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // Type-only at runtime, but alias it anyway so transforms never choke.
      '@server': fileURLToPath(new URL('./server/src', import.meta.url)),
    },
  },
  test: {
    include: ['scripts/scan-transforms/**/*.test.mts'],
    environment: 'node',
  },
});
