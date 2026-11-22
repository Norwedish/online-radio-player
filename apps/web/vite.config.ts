import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

const api = process.env.VITE_API_TARGET ?? "http://127.0.0.1:3001";
const icecast = process.env.VITE_ICECAST_TARGET ?? "http://127.0.0.1:8000";
const live = process.env.VITE_LIVE_TARGET ?? "ws://127.0.0.1:3102";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": api,
      "/metrics": api,
      "/ws/live": { target: live, ws: true, rewrite: (p) => p.replace(/^\/ws\/live/, "/live") },
      "/ws": { target: api.replace(/^http/, "ws"), ws: true },
      // Same-origin audio for the dev listener page → Icecast (nginx does this in production).
      "/stream": {
        target: icecast,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/stream/, ""),
      },
      "/hls": { target: api, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true, chunkSizeWarningLimit: 900 },
});
