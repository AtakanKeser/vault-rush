import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Dev server port and API proxy target. Both default to the values in the
// spec (3000 / http://localhost:8080) but can be overridden when those ports
// are taken on a developer machine:
//   ADMIN_PORT=3100 VITE_PROXY_TARGET=http://localhost:8089 npm run dev
const port = Number(process.env.ADMIN_PORT || 3000)
const target = process.env.VITE_PROXY_TARGET || 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    port,
    strictPort: true,
    proxy: {
      '/admin': { target, changeOrigin: true },
      '/healthz': { target, changeOrigin: true },
      '/readyz': { target, changeOrigin: true },
      '/metrics': { target, changeOrigin: true },
    },
  },
  preview: { port },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
})
