import { appendFileSync } from "node:fs";
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
 * lies around VISUAL_NOW, far outside the window, and stays as it is. `hold` gives fixed values
 * for keys of the answer (HELD).
 */
export function shiftTimes(
  value: unknown,
  realNow: number,
  hold: Readonly<Record<string, unknown>> = {},
): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => shiftTimes(item, realNow, hold));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => !(key in hold && hold[key] === undefined))
        .map(([key, item]) => [
          key,
          key in hold && (typeof item === "number" || Array.isArray(item))
            ? hold[key]
            : shiftTimes(item, realNow, hold),
        ]),
    );
  }
  const stamp =
    typeof value === "number" &&
    Number.isInteger(value) &&
    Math.abs(value - realNow) < STAMP_WINDOW_MS;
  return stamp ? VISUAL_NOW + Math.round((value - realNow) / DAY_MS) * DAY_MS : value;
}

/**
 * Values that grow with the run, in whatever order its workers take the pages, held at fixed
 * values in the answers of their own endpoints only (`undefined` leaves the key out):
 *
 * - public links and snapshots count each page load of a public page;
 * - a data source shows the hours of the last day with queries and its last use, which depend
 *   on which pages ran queries before.
 */
const HELD: readonly { path: RegExp; keys: Readonly<Record<string, unknown>> }[] = [
  {
    path: /\/api\/orgs\/[^/]+\/(dashboards\/[^/]+\/)?(public-links|snapshots)(\/[^/]+)?$/,
    keys: { views: 12, lastViewedAt: VISUAL_NOW - 2 * 3_600_000 },
  },
  {
    path: /\/api\/orgs\/[^/]+\/datasources(\/[^/]+)?$/,
    keys: { latency: [], lastUsedAt: undefined },
  },
];

const heldKeys = (path: string) =>
  Object.assign({}, ...HELD.filter((held) => held.path.test(path)).map((held) => held.keys));

/** A seeded generator in place of Math.random, so layouts that start from chance repeat. */
function seededRandom(): void {
  let seed = 20250618;
  Math.random = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
}

/**
 * The fonts of the pictures. The UI brings its own faces (Instrument Sans, JetBrains Mono); for
 * every glyph they lack, the browser would take a font of the system, which differs between
 * machines. Here the font stacks end in Noto Sans and Noto Sans Mono (OFL-1.1, dev dependencies,
 * for the pictures only), served from the page's own origin, so every Linux machine draws the
 * same glyphs.
 */
const FONT_PATH = "/__visual-fonts/";
const FONT_FILES: Readonly<Record<string, string>> = {
  "sans.woff2": "@fontsource-variable/noto-sans/files/noto-sans-latin-wght-normal.woff2",
  "mono.woff2": "@fontsource-variable/noto-sans-mono/files/noto-sans-mono-latin-wght-normal.woff2",
};
const NODE_MODULES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "node_modules");

function visualFonts(path: string): void {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    @font-face { font-family: "Visual Sans"; src: url("${path}sans.woff2") format("woff2"); font-weight: 100 900; }
    @font-face { font-family: "Visual Mono"; src: url("${path}mono.woff2") format("woff2"); font-weight: 100 900; }
    :root {
      --font-sans: "Instrument Sans Variable", "Visual Sans";
      --font-mono: "JetBrains Mono Variable", "Visual Mono";
    }
  `);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}

/** Answers the setup captured, for lists that grow with the run (Explore's history). */
export type Frozen = Record<string, unknown>;

/**
 * Prepares a context: the seeded generator, the fonts, the server's times moved to the fixed
 * moment, frozen answers for lists that grow with the run, and no recorded dashboard views (they
 * would change the recent dashboards and the usage counts while the run goes on).
 */
export async function stageContext(context: BrowserContext, frozen: Frozen): Promise<void> {
  await context.addInitScript(seededRandom);
  await context.addInitScript(visualFonts, FONT_PATH);
  await context.route(`**${FONT_PATH}*`, (route) => {
    const file = FONT_FILES[new URL(route.request().url()).pathname.slice(FONT_PATH.length)];
    return file === undefined
      ? route.fulfill({ status: 404 })
      : route.fulfill({ path: join(NODE_MODULES, file), contentType: "font/woff2" });
  });
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
    const hold = heldKeys(url.pathname);
    if (request.method() === "GET") {
      for (const [pattern, body] of Object.entries(frozen)) {
        if (new RegExp(pattern).test(`${url.pathname}${url.search}`)) {
          return route.fulfill({ json: shiftTimes(body, realNow, hold) });
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
    return route.fulfill({ response, json: shiftTimes(JSON.parse(text), realNow, hold) });
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
    // Whole pixels for every scroll position: a page scrolled to a fraction of a pixel (a result
    // scrolled into view) drew fixed and sticky parts a pixel apart from run to run.
    for (const element of [document.scrollingElement, ...document.querySelectorAll("*")]) {
      if (element !== null && (element.scrollTop % 1 !== 0 || element.scrollLeft % 1 !== 0)) {
        element.scrollTo(Math.round(element.scrollLeft), Math.round(element.scrollTop));
      }
    }
    // A page scrolled to its very end (a result scrolled into view) pushes the sticky sidebar up
    // by the fraction of a pixel the page's height has beyond a whole one, drawn a pixel apart
    // from run to run. One pixel short of the end, the sidebar stays at the top.
    const page = document.scrollingElement;
    if (page !== null) {
      const end = page.scrollHeight - page.clientHeight;
      if (page.scrollTop > 0 && page.scrollTop >= end - 1) {
        page.scrollTo(page.scrollLeft, Math.max(0, end - 2));
      }
    }
  });
  // No hover state and no tooltip from where the pointer happened to be.
  await page.mouse.move(0, 0);
}

/*
 * The places that show such text, as KALZIT_VISUAL_DISCOVER=1 listed them (steadyRules). Text of
 * the same form elsewhere stays: the trace durations and the addresses of the Tempo source and
 * the AI gateway come from the fixtures and are the same in every run.
 */
/** Paths in the run folder: locked folder settings, a source's address, file and form. */
const RUN_FOLDER =
  ".settings-locked .input, .ds-table__address, .source-query__summary dd, .ds-section .field .input";
/** Ids of this run: the audit details, a link's address, a service account's example. */
const IDS = ".admin-row__meta, .share-address .input, .admin-sa-secret__text";
/** The server's own address with its free port: a link's address, a service account's example. */
const ADDRESSES = ".share-address .input, .admin-sa-secret__text";
/** The machine's name: the instances and the updates page. */
const HOSTS = ".instances__server .updates-strong, .updates-strip__value .updates-strong";
/** How long a query took: Explore's result bar, the panel editor's query stats. */
const DURATIONS = ".explore__size, .target__stats";
/** Free space in the data folder and the size of the database: the update checks. */
const DISK = ".updates-checks__item .updates-muted";
/** The instance id, commit and build date: the instances table and About. */
const BUILD = ".updates-mono, .about-facts dd";

/** Text that differs by machine or run, in the places of the UI that show it. */
interface SteadyRule {
  /** What the text is, for the discovery report. */
  what: string;
  /** The elements that show it; nothing outside them is touched. */
  selector: string;
  /** The text itself, a regular expression source (case-sensitive). */
  pattern: string;
}

const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The places that show text differing by machine or run: paths in the run folder (data directory,
 * fixture files), the server's address with its free port, the host name, ids the server makes
 * up, what the seed read (`extra`: the instance id, the commit and the build date), measured
 * times ("10 ms") and the disk and database sizes. Whole ids and paths come first: the instance
 * id's short form is also the start of every id made in the same moment.
 *
 * A new place shows up as a flaky picture; `KALZIT_VISUAL_DISCOVER=1 npm run visual` lists every
 * match outside these selectors in e2e/.output/visual-discover.jsonl.
 */
function steadyRules(extra: readonly string[]): SteadyRule[] {
  const host = hostname();
  return [
    {
      what: "run folder",
      selector: RUN_FOLDER,
      pattern: "\\S*[\\\\/]run-\\d{10,}-\\d+[\\\\/]\\S*",
    },
    {
      what: "id",
      selector: IDS,
      pattern: "\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b",
    },
    { what: "server address", selector: ADDRESSES, pattern: "\\b127\\.0\\.0\\.1:\\d{4,5}\\b" },
    ...(host.length >= 3
      ? [{ what: "host name", selector: HOSTS, pattern: `(?<![\\w.-])${literal(host)}(?![\\w.-])` }]
      : []),
    { what: "measured time", selector: DURATIONS, pattern: "\\b\\d[\\d,.]*\\s?ms\\b" },
    { what: "disk or database size", selector: DISK, pattern: "\\b\\d[\\d,.]*\\s?[kMGT]?B\\b" },
    ...extra.map((text) => ({
      what: "build or instance",
      selector: BUILD,
      pattern: `\\b${literal(text)}\\b`,
    })),
  ];
}

/** What stands in for text that differs by machine or run. */
export const STEADY = "•••";

const DISCOVER_FILE = join(VISUAL_DIR, "..", "visual-discover.jsonl");

/** Notes the matches outside the known places of one picture (discovery), one line each. */
export function noteUnplaced(picture: string, unplaced: readonly Unplaced[]): void {
  for (const one of unplaced) {
    appendFileSync(DISCOVER_FILE, `${JSON.stringify({ picture, ...one })}\n`);
  }
}

/** Where a match outside the known places was found (discovery). */
export interface Unplaced {
  what: string;
  element: string;
}

/**
 * Replaces text that differs by machine or run with the same placeholder in every run, in text
 * and in fields of the places steadyRules names, just before a picture. The placeholder keeps the
 * boxes around it the same size in every run, which a mask over the varying text would not.
 * With `discover`, it replaces matches anywhere and answers those outside the known places.
 */
export async function steadyText(
  page: Page,
  extra: readonly string[] = [],
  discover = process.env.KALZIT_VISUAL_DISCOVER === "1",
): Promise<Unplaced[]> {
  return page.evaluate(
    ({ rules, placeholder, discover }) => {
      const unplaced: { what: string; element: string }[] = [];
      const pathOf = (element: Element) => {
        const parts: string[] = [];
        for (
          let at: Element | null = element;
          at !== null && parts.length < 4;
          at = at.parentElement
        ) {
          const classes = [...at.classList]
            .slice(0, 2)
            .map((name) => `.${name}`)
            .join("");
          parts.unshift(`${at.tagName.toLowerCase()}${classes}`);
        }
        return parts.join(" > ");
      };
      for (const rule of rules) {
        const pattern = new RegExp(rule.pattern, "g");
        const scopes = discover ? [document.body] : [...document.querySelectorAll(rule.selector)];
        for (const scope of scopes) {
          const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
          const fields = [
            ...(scope.matches("input, textarea") ? [scope] : []),
            ...scope.querySelectorAll("input, textarea"),
          ] as (HTMLInputElement | HTMLTextAreaElement)[];
          const found: Element[] = [];
          for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
            const text = node.textContent ?? "";
            const replaced = text.replace(pattern, placeholder);
            if (replaced !== text) {
              node.textContent = replaced;
              if (node.parentElement !== null) found.push(node.parentElement);
            }
          }
          for (const field of fields) {
            const replaced = field.value.replace(pattern, placeholder);
            if (replaced !== field.value) {
              field.value = replaced;
              found.push(field);
            }
          }
          if (discover) {
            for (const element of found) {
              if (element.closest(rule.selector) === null) {
                unplaced.push({ what: rule.what, element: pathOf(element) });
              }
            }
          }
        }
      }
      return unplaced;
    },
    { rules: steadyRules(extra), placeholder: STEADY, discover },
  );
}
