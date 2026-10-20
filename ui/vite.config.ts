import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Rust server listens here during development; the UI is served from the same origin in
// production, so the dev server proxies every server route instead of using CORS.
const SERVER = "http://127.0.0.1:3000";
const proxy = {
  "/api": SERVER,
  "/healthz": SERVER,
  "/readyz": SERVER,
};

export default defineConfig({
  plugins: [react(), babel({ presets: [reactCompilerPreset()] })],
  server: { proxy },
  preview: { proxy },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The bundle is embedded in the server binary; source maps would only add weight to it.
    sourcemap: false,
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
  },
});
