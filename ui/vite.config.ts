import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// The Rust server listens here during development; the UI is served from the same origin in
// production, so the dev server proxies every server route instead of using CORS.
const SERVER = "http://127.0.0.1:3000";
const proxy = {
  // Live updates (docs/api/live.md) are a WebSocket under /api.
  "/api": { target: SERVER, ws: true },
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
    modulePreload: {
      // The chart's chunks are fetched by the import itself. Preloading them from a link element
      // right before the import makes WebKit report "preloaded but not used" whenever its import
      // does not pick up the preloaded copy (the stylesheet is still preloaded).
      resolveDependencies: (filename, deps) =>
        filename.includes("UplotTimeSeriesChart")
          ? deps.filter((dep) => dep.endsWith(".css"))
          : deps,
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./vitest.setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    unstubGlobals: true,
    // Half the cores: with every core busy, jsdom tests near the 5 s timeout under load.
    maxWorkers: "50%",
    // The reporter flags tests over 1 s as a warning. Speed up a flagged test (paste instead of
    // type, smaller fixtures) rather than raising the 5 s default timeout.
    slowTestThreshold: 1000,
  },
});
