import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import babel from "@rolldown/plugin-babel";
import react, { reactCompilerPreset } from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";
import { handbook } from "./src/handbook/build/plugin.ts";

// The server's version, so links to the docs point at this release's tag (src/help/docs.ts).
const serverManifest = readFileSync(new URL("../server/Cargo.toml", import.meta.url), "utf8");
const version = /^version = "([^"]+)"$/m.exec(serverManifest)?.[1];
if (version === undefined) {
  throw new Error("no version in server/Cargo.toml");
}

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
  // Relative, so the bundle works under any sub-path (`server.base_path`): the server writes the
  // prefix into index.html (`web::index_html`), and chunks find each other from their own URL.
  base: "./",
  plugins: [
    react(),
    babel({ presets: [reactCompilerPreset()] }),
    // The built-in handbook: the guide's pages, pictures and search index (src/handbook).
    handbook(fileURLToPath(new URL(".", import.meta.url))),
  ],
  define: { __KALZIT_VERSION__: JSON.stringify(version) },
  // The help pages before sign-in and the handbook are files of docs/ (src/help, src/handbook).
  server: { proxy, fs: { allow: [".", "../docs"] } },
  preview: { proxy },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // The bundle is embedded in the server binary; source maps would only add weight to it.
    sourcemap: false,
    // The handbook's pages, pictures and search index stay files of their own, fetched when shown:
    // inlined, a small page would become part of the script that lists them.
    assetsInlineLimit: (file) => (/[\\/]docs[\\/]|kalzit-handbook/.test(file) ? false : undefined),
    modulePreload: {
      // index.html keeps its modulepreload links: the first page load needs those chunks at once.
      // A lazy chunk (a route, a dialog, the chart, the editor) fetches its scripts through the
      // import itself instead of `<link rel="modulepreload">` elements added right before it.
      // WebKit starts a 3 s timer at the load event whenever the page has link preloads (the
      // ones in index.html) and then warns "preloaded using link preload but not used" for every
      // link preload the module loader has not asked for yet. A route opened about 3 s after
      // the load, while its chunk is still loading, hit that with all of its dependencies.
      // Stylesheets of lazy chunks are still added (as stylesheets, which that timer ignores).
      // The cost: the first visit to a lazy route finds its imports one level at a time; assets
      // are cached as immutable and route preloading on hover starts the import early.
      resolveDependencies: (_filename, deps, { hostType }) =>
        hostType === "html" ? deps : deps.filter((dep) => dep.endsWith(".css")),
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
