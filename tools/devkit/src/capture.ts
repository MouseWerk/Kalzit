import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { type Locale, launch, openVariant, settle, type Theme, variants } from "./browser.ts";
import { KalzitClient } from "./instance/client.ts";
import { findInstance, resolveBinary } from "./instance/manager.ts";
import { outDir, stamp, UI_DIR } from "./paths.ts";
import { run } from "./proc.ts";
import { resolvePath, selectScreens } from "./screens.ts";

export interface CaptureOptions {
  instance?: string;
  /** Screen names or paths; all main screens when empty. */
  screens?: string[];
  locales?: Locale[];
  themes?: Theme[];
  widths?: number[];
  height?: number;
  fullPage?: boolean;
  out?: string;
  /**
   * Existing shots scenes to run through the e2e harness (each starts its own isolated server
   * with the same binary): readme, sign-in, two-factor, access, gallery.
   */
  scenes?: string[];
}

export interface CaptureEntry {
  screen: string;
  path: string;
  locale: Locale;
  theme: Theme;
  width: number;
  file?: string;
  error?: string;
}

export interface CaptureManifest {
  out: string;
  instance?: string;
  url?: string;
  entries: CaptureEntry[];
  scenes: { scene: string; code: number; out: string; files: string[]; log: string }[];
}

const SCENES: Record<string, { config: string; file: string; outVar: string }> = {
  readme: {
    config: "screenshots.config.ts",
    file: "readme.shots.ts",
    outVar: "KALZIT_SCREENSHOTS_OUT",
  },
  "sign-in": {
    config: "screenshots.config.ts",
    file: "sign-in.shots.ts",
    outVar: "KALZIT_SCREENSHOTS_OUT",
  },
  "two-factor": {
    config: "screenshots.config.ts",
    file: "two-factor.shots.ts",
    outVar: "KALZIT_SCREENSHOTS_OUT",
  },
  access: {
    config: "screenshots.config.ts",
    file: "access.shots.ts",
    outVar: "KALZIT_SCREENSHOTS_OUT",
  },
  gallery: { config: "gallery.config.ts", file: "gallery.shots.ts", outVar: "KALZIT_GALLERY_OUT" },
};

export const SCENE_NAMES = Object.keys(SCENES);

export function captureFileName(
  screen: string,
  v: { locale: string; theme: string; width: number },
): string {
  return `${screen}--${v.locale}-${v.theme}-${v.width}.png`;
}

function pngsBelow(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const path = join(d, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (name.endsWith(".png")) found.push(relative(dir, path).replaceAll("\\", "/"));
    }
  };
  walk(dir);
  return found.sort();
}

export async function captureScreens(options: CaptureOptions): Promise<CaptureManifest> {
  const out = resolve(options.out ?? outDir("captures", stamp()));
  mkdirSync(out, { recursive: true });
  const manifest: CaptureManifest = { out, entries: [], scenes: [] };
  const wantsScreens =
    options.scenes === undefined ||
    options.scenes.length === 0 ||
    (options.screens?.length ?? 0) > 0;

  if (wantsScreens) {
    const { state, credentials } = findInstance(options.instance);
    manifest.instance = state.id;
    manifest.url = state.url;
    const screens = selectScreens(options.screens, state);
    const browser = await launch();
    try {
      for (const variant of variants(
        options.locales ?? ["en", "de"],
        options.themes ?? ["light", "dark"],
        options.widths ?? [1440, 1024],
        options.height ?? 900,
      )) {
        const signedIn = await openVariant(browser, state, credentials, variant, false);
        const signedOut = await openVariant(browser, state, credentials, variant, true);
        for (const screen of screens) {
          const entry: CaptureEntry = {
            screen: screen.name,
            path: screen.path,
            locale: variant.locale,
            theme: variant.theme,
            width: variant.width,
          };
          try {
            entry.path = resolvePath(screen.path, state);
            const page = screen.signedOut === true ? signedOut.page : signedIn.page;
            await page.goto(entry.path);
            await settle(page);
            const file = join(out, captureFileName(screen.name, variant));
            await page.screenshot({
              path: file,
              fullPage: options.fullPage === true,
              animations: "disabled",
              caret: "hide",
              scale: "css",
            });
            entry.file = file;
          } catch (error) {
            entry.error = (error as Error).message.split("\n")[0] ?? "error";
          }
          manifest.entries.push(entry);
        }
        await signedIn.context.close();
        await signedOut.context.close();
      }
    } finally {
      await browser.close();
      await resetPreferences(state.url, credentials.owner);
    }
  }

  for (const scene of options.scenes ?? []) {
    const spec = SCENES[scene];
    if (spec === undefined)
      throw new Error(`unknown scene ${scene}; known: ${SCENE_NAMES.join(", ")}`);
    const sceneOut = join(out, "scenes", scene);
    const binary = await resolveBinary({});
    const log = join(out, `scene-${scene}.log`);
    // The Playwright CLI run by this Node directly, without npx or a shell.
    const cli = join(UI_DIR, "node_modules", "@playwright", "test", "cli.js");
    const args = [cli, "test", "-c", `e2e/${spec.config}`, spec.file];
    const result = await run(process.execPath, args, {
      cwd: UI_DIR,
      env: {
        ...process.env,
        KALZIT_E2E_BINARY: binary,
        KALZIT_E2E_RUN_DIR: outDir("e2e-runs", stamp()),
        KALZIT_E2E_BROWSERS: "chromium",
        [spec.outVar]: sceneOut,
      },
      onOutput: (text) => writeFileSync(log, text, { flag: "a" }),
    });
    let files: string[] = [];
    try {
      files = pngsBelow(sceneOut);
    } catch {
      // The scene wrote nothing.
    }
    manifest.scenes.push({ scene, code: result.code, out: sceneOut, files, log });
  }

  writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

/** Puts the owner's language and theme back to "not chosen" after the variants. */
export async function resetPreferences(
  url: string,
  owner: { email: string; password: string } | undefined,
): Promise<void> {
  if (owner === undefined) return;
  try {
    const client = await KalzitClient.signIn(url, owner.email, owner.password);
    await client.setPreferences({ language: null, theme: null });
  } catch {
    // Best effort: the next run sets them again.
  }
}
