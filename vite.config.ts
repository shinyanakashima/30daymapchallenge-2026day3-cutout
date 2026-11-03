import { defineConfig } from 'vite';

// base は相対パス。GitHub Pages 等のサブパス配信でもそのまま動くようにする
export default defineConfig({
  base: './',
  worker: { format: 'es' },
  optimizeDeps: { exclude: ['@duckdb/duckdb-wasm'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
});
