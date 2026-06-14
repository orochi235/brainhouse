import { resolve } from 'node:path';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@server': resolve(__dirname, '../server/src'),
    },
  },
  server: {
    port: 8766,
    // Cross-origin isolation so performance.measureUserAgentSpecificMemory()
    // is available (it gates on crossOriginIsolated) — used by the memory
    // telemetry to get a typed footprint breakdown while chasing the non-JS
    // renderer creep. COEP: credentialless still isolates but loads
    // cross-origin subresources (e.g. external screenshots) without
    // credentials rather than blocking them outright. Remove this block to
    // restore normal cross-origin loading.
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
    proxy: {
      '/trpc': 'http://127.0.0.1:8765',
      '/health': 'http://127.0.0.1:8765',
    },
  },
  build: {
    outDir: '../server/dist/public',
    emptyOutDir: true,
  },
  plugins: [react()],
});
