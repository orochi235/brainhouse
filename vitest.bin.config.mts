import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['bin/**/*.test.js', 'hooks/**/*.test.mjs', 'scripts/**/*.test.mjs'],
    environment: 'node',
  },
});
