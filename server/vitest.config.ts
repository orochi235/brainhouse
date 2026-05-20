import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // node:sqlite (and any other `node:` built-in) should be treated as
    // external by Vite's module resolver — otherwise it tries to load
    // them as bare modules from node_modules. The default behavior
    // works for most built-ins; sqlite specifically is newer and
    // sometimes slips through.
    deps: {
      // node:sqlite (and any other `node:` built-in) should be treated as
      // external — vitest 2's resolver doesn't recognize the `node:`
      // prefix for newer built-ins by default.
      external: [/^node:/],
    },
  },
});
