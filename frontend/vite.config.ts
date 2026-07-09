import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

// Locally (npm run dev outside Docker), the backend is reachable at
// localhost:8000. Inside the Docker Compose network (see compose.yml's
// frontend service), "localhost" would resolve to the frontend container
// itself -- VITE_API_PROXY_TARGET is set there to the "backend" service's
// Compose DNS name instead.
const apiTarget = process.env.VITE_API_PROXY_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  build: {
    chunkSizeWarningLimit: 600,
  },
  server: {
    port: 5173,
    host: true, // listen on 0.0.0.0 so the dev server is reachable from outside its container
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
      "/api/v1/ws": { target: apiTarget.replace(/^http/, "ws"), ws: true, changeOrigin: true },
    },
  },
});
