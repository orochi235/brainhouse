import { resolve } from 'node:path';
import react from '@vitejs/plugin-react-swc';
import { defineConfig } from 'vite';

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: {
      '@server': resolve(__dirname, '../server/src'),
      '@windease/core': resolve(__dirname, '../../windease/packages/core/src/index.ts'),
      '@windease/react': resolve(__dirname, '../../windease/packages/react/src/index.ts'),
    },
  },
  server: {
    port: 8766,
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
