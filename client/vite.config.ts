/// <reference types="vitest/config" />
import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: { target: 'es2022', sourcemap: false, assetsInlineLimit: 8192 },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
});
