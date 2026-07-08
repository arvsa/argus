// @ts-check
// Separate config from vite.config.ts to avoid Vite 8 (rolldown) / vitest 3
// (rollup) type incompatibility. Runtime behaviour is fine.
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // @ts-ignore — plugin types incompatible between vite 8 and vitest 3's bundled vite
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
});
