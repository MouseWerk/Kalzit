import { hostname } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserContext, Page, Route } from "@playwright/test";

/**
 * What makes a page look the same in every run: a fixed moment, server times moved to it, no
 * counters that grow with the run, a seeded random number generator, and placeholders for the few
 * things that differ by machine (paths of the run folder, the server's port, the host name).
 */

/**
 * The moment the pages show; the fixture data covers the six hours before it. It lies more than
 * 400 days before any run, so the times the server stamps during a run (always near the real
 * now) can be told apart from the fixture's (shiftTimes below).
 */
export const VISUAL_NOW = Date.UTC(2025, 5, 18, 9, 30, 0);

const DAY_MS = 24 * 60 * 60 * 1000;
/** Server times within this distance of the real now are stamps of this run. */
const STAMP_WINDOW_MS = 400 * DAY_MS;

/** Where the setup leaves the owner's session and the ids of what it seeded. */
export const VISUAL_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  ".output",
  "visual",
);
export const STATE_FILE = join(VISUAL_DIR, "owner.json");
export const SEED_FILE = join(VISUAL_DIR, "seed.json");

/** Where the setup keeps its picture of a step, for the width projects to compare. */
export const setupShot = (width: { name: string }, step: string, theme: string): string =>
  join(VISUAL_DIR, "setup", width.name, `${step.replace(/[^a-z0-9]+/gi, "-")}--${theme}.png`);

/**
 * Moves every server timestamp (Unix ms, as the API writes times) of this run to the fixed
 * moment, keeping whole days apart: "created now, expires in 30 days" stays so. The fixture data
 * lies around VISUAL_NOW, far outside the window, and stays as it is.
 */
export function shiftTimes(value: unknown, realNow: number): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shiftTimes(item, realNow));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !(key === "lastUsedAt" && typeof item === "number"))
        .map(([key, item]) => [key, counter(key, item, realNow)]),
    );
  }
  const stamp =
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value - realNow) < STAMP_WINDOW_MS;
  return stamp ? VISUAL_NOW + Math.round((value - realNow) / DAY_MS) * DAY_MS : value;
}

/**
 * Counters of page loads grow with every visit of a public page, in whatever order the run's
 * workers take the pages; they show a fixed count instead.
 */
const VISITS: Readonly<Record<string, unknown>> = {
  views: 12,
  lastViewedAt: VISUAL_NOW - 2 * 3_600_000,
};

/**
 * What a data source shows of the queries that ran on it (the hours with queries, the last use)
 * depends on which pages ran queries before, in whatever order: it shows none. `lastUsedAt` is
 * left out (shiftTimes), `latency` is empty.
 */
function counter(key: string, item: unknown, realNow: number): unknown {
  if (key === "latency" && Array.isArray(item)) {
    return [];
  }
  if (key in VISITS && (typeof item === "number" || item === null)) {
    return key === "lastViewedAt" && item === null ? null : VISITS[key];
  }
  return shiftTimes(item, realNow);
}

/** A seeded generator in place of Math.random, so layouts that start from chance repeat. */
function seededRandom(): void {
  let seed = 20250618;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/** Answers the setup captured, for lists that grow with the run (Explore's history). */
export type Frozen = Record<string, unknown>;

/**
 * Prepares a context: the seeded generator, the server's times moved to the fixed moment,
 * frozen answers for lists that grow with the run, and no recorded dashboard views (they would
 * change the recent dashboards and the usage counts while the run goes on).
 */
export async function stageContext(context: BrowserContext, frozen: Frozen): Promise<void> {
  await context.addInitScript(seededRandom);
  const realNow = Date.now();
  await context.route(/\/api\//, async (route: Route) => {
    const request = route.request();
    // A stream (the AI chat) never ends, so it cannot be read whole first.
    if ((request.headers().accept ?? "").includes("text/event-stream")) {
      return route.fallback();
    }
    const url = new URL(request.url());
    if (request.method() === "POST" && /\/dashboards\/[^/]+\/views$/.test(url.pathname)) {
      return route.fulfill({ status: 204 });
    }
    if (request.method() === "GET") {
      for (const [pattern, body] of Object.entries(frozen)) {
        if (new RegExp(pattern).test(`${url.pathname}${url.search}`)) {
          return route.fulfill({ json: shiftTimes(body, realNow) });
        }
      }
    }
    let response: Awaited<ReturnType<Route["fetch"]>>;
    try {
      response = await route.fetch();
    } catch {
      // The page went on or closed while the request was under way.
      return route.abort().catch(() => {});
    }
    const type = response.headers()["content-type"] ?? "";
    if (!type.includes("application/json")) {
      return route.fulfill({ response });
    }
    const text = await response.text();
    if (text === "") {
      return route.fulfill({ response });
    }
    return route.fulfill({ response, json: shiftTimes(JSON.parse(text), realNow) });
  });
}

/** Stops the page's clock at the fixed moment; timers keep running, so the app works as usual. */
export async function stagePage(page: Page): Promise<void> {
  await page.clock.setFixedTime(VISUAL_NOW);
}

/**
 * Waits until the page stopped changing: requests done, fonts in, no busy region, and the
 * document quiet for a moment. The comparison itself then waits for two equal pictures.
 */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle");
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((done) => {
      let timer = setTimeout(finish, 300);
      const limit = setTimeout(finish, 5000);
      const observer = new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(finish, 300);
      });
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
      });
      function finish() {
        clearTimeout(timer);
        clearTimeout(limit);
        observer.disconnect();
        done();
      }
    });
  });
  // No hover state and no tooltip from where the pointer happened to be.
  await page.mouse.move(0, 0);
}

/**
 * Text that differs by machine or run, as regular expression sources: paths in the run folder
 * (data directory, fixture files), the server's address with its free port (link addresses), the
 * host name, ids the server makes up, what the seed read (`extra`: the instance id, the commit
 * and the build date), measured times ("10 ms": how long a query or a check took) and the free
 * disk space.
 */
function dynamicText(extra: readonly string[]): string[] {
  const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const host = literal(hostname());
  // Whole ids and paths first: the instance id's short form is also the start of every id made
  // in the same moment, and replacing it first would leave the rest of those ids behind.
  return [
    "\\S*[\\\\/]run-\\d{10,}-\\d+[\\\\/]\\S*",
    "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
    "127\\.0\\.0\\.1:\\d{2,5}",
    "localhost:\\d{2,5}",
    ...(host.length >= 3 ? [`\\b${host}\\b`] : []),
    "\\b\\d[\\d,.]*\\s?ms\\b",
    "\\b\\d[\\d,.]*\\s?[kMGT]?B free\\b",
    ...extra.map((text) => `\\b${literal(text)}\\b`),
  ];
}

/** What stands in for text that differs by machine or run. */
export const STEADY = "•••";

/**
 * Replaces text that differs by machine or run (dynamicText) with the same placeholder in every
 * run, in text and in fields, just before a picture. The placeholder keeps the boxes around it
 * the same size in every run, which a mask over the varying text would not.
 */
export async function steadyText(page: Page, extra: readonly string[] = []): Promise<void> {
  await page.evaluate(
    ({ sources, placeholder }) => {
      const patterns = sources.map((source) => new RegExp(source, "gi"));
      const steady = (text: string) =>
        patterns.reduce((result, pattern) => result.replace(pattern, placeholder), text);
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
        const text = node.textContent ?? "";
        const replaced = steady(text);
        if (replaced !== text) {
          node.textContent = replaced;
        }
      }
      for (const field of document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>(
        "input, textarea",
      )) {
        const replaced = steady(field.value);
        if (replaced !== field.value) {
          field.value = replaced;
        }
      }
    },
    { sources: dynamicText(extra), placeholder: STEADY },
  );
}
