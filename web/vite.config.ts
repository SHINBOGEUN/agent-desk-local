import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The server only accepts its own Host and Origin, so the dev proxy presents both.
// The dashboard is served by `agent-desk serve` from web/dist. In dev, /api goes to the running server.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:4317', changeOrigin: true, headers: { Origin: 'http://127.0.0.1:4317' } } } },
  build: { outDir: 'dist', sourcemap: false },
});
