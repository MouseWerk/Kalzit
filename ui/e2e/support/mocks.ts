import type { Page } from "@playwright/test";

/**
 * Server answers for the page checks that a fresh server cannot give on its own: AI in use (it
 * needs a provider and the server switch, which other tests turn off), an installed plugin (it
 * needs the test plugin's binary) and a loaded plugin catalog (it needs HTTPS with a trusted
 * certificate). Only the GET of each route is answered; everything else reaches the server.
 */

const NOW = Date.UTC(2026, 9, 15, 9, 0);
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** The plugin the plugin page shows. */
export const MOCK_PLUGIN = { id: "dev.e2etest.meters", name: "Energy meters" } as const;

const PUBLISHER = "Basalt Labs";
const KEY_ID = "4be1c0ffee09fa21";

async function answerGet(page: Page, url: RegExp, json: unknown): Promise<void> {
  await page.route(url, (route) =>
    route.request().method() === "GET" ? route.fulfill({ json }) : route.continue(),
  );
}

/** AI on and usable in every organization, with the first-use notice read. */
export async function aiInUse(page: Page): Promise<void> {
  await answerGet(page, /\/api\/orgs\/[^/]+\/ai\/status(\?|$)/, {
    enabled: true,
    usable: true,
    orgProvidersAllowed: true,
    noticeAcknowledged: true,
    provider: { id: "p1", name: "Local gateway", kind: "openai", model: "model-1" },
    usage: {
      requests: 3,
      tokens: 1_200,
      requestsLimit: 100,
      tokensLimit: 100_000,
      orgTokensMonth: 12_000,
      orgTokensMonthLimit: 1_000_000,
    },
    maxRowsToModel: 200,
  });
}

/** One installed, running data source plugin with a log. */
export async function installedPlugin(page: Page): Promise<void> {
  const base = `/api/admin/plugins/${MOCK_PLUGIN.id.replaceAll(".", "\\.")}`;
  await answerGet(page, new RegExp(`${base}(\\?|$)`), {
    id: MOCK_PLUGIN.id,
    name: MOCK_PLUGIN.name,
    version: "1.2.0",
    kind: "datasource",
    description: "Reads energy meters and PDUs over Modbus TCP.",
    publisher: PUBLISHER,
    license: "Apache-2.0",
    shapes: ["frame"],
    capabilities: ["query", "health"],
    platforms: ["linux-x64", "windows-x64"],
    signer: "publisher",
    keyId: KEY_ID,
    trusted: true,
    approved: true,
    enabled: true,
    running: true,
    permissions: [{ setting: "host", form: "host", defaultPort: "502", protocol: "tcp" }],
    process: {
      state: "running",
      pid: 4242,
      startedAt: NOW - 2 * HOUR,
      starts: 1,
      failures: 0,
      sandbox: ["landlock", "seccomp"],
      sandboxMissing: [],
      warnings: [],
    },
    installedAt: NOW - 3 * DAY,
    updatedAt: NOW - 3 * DAY,
    manifest: `id = "${MOCK_PLUGIN.id}"\nname = "${MOCK_PLUGIN.name}"\nversion = "1.2.0"\n`,
    usedIn: [],
  });
  await answerGet(page, new RegExp(`${base}/logs(\\?|$)`), {
    lines: [
      { at: NOW - 2 * HOUR, stream: "host", text: "started" },
      { at: NOW - 2 * HOUR + 1_000, stream: "stdout", text: "listening on the plugin socket" },
    ],
    dropped: 0,
  });
}

/** A loaded catalog signed by a trusted publisher, with one entry per action. */
export async function loadedCatalog(page: Page): Promise<void> {
  const host = "plugins.basalt.example";
  const entry = (
    id: string,
    name: string,
    kind: string,
    action: string,
    publisher = PUBLISHER,
  ) => ({
    id,
    name,
    kind,
    version: "1.0.0",
    description: `${name}, from the catalog of ${publisher}.`,
    publisher,
    keyId: publisher === PUBLISHER ? KEY_ID : "9d44c1e07a52f6b2",
    ...(publisher === PUBLISHER ? { keyName: PUBLISHER } : {}),
    network: kind === "datasource" ? ["<host>:502"] : [],
    size: 2_400_000,
    sha256: "4be1c0ffee09fa".padEnd(64, "0"),
    urlHost: host,
    action,
    ...(action === "installed" || action === "update" ? { installedVersion: "0.9.0" } : {}),
  });
  const items = [
    entry(MOCK_PLUGIN.id, MOCK_PLUGIN.name, "datasource", "installed"),
    entry("dev.basalt.redfish", "Redfish BMC", "datasource", "install"),
    entry("dev.basalt.panel-kpi", "KPI tile", "panel", "update"),
    entry("de.nordlicht.heatmap", "Calendar heatmap", "panel", "untrusted", "nordlicht.example"),
  ];
  const setting = (value: unknown, version: number) => ({ value, version, editable: true });
  await answerGet(page, /\/api\/admin\/plugin-catalog(\?|$)/, {
    state: "ready",
    settings: {
      enabled: setting(true, 2),
      url: setting(`https://${host}/index.json`, 2),
      refreshHours: setting(24, 1),
    },
    index: {
      sequence: 42,
      publishedAt: NOW - 2 * DAY,
      expiresAt: NOW + 28 * DAY,
      fetchedAt: NOW - HOUR,
      keyId: KEY_ID,
      signer: PUBLISHER,
      host,
    },
    checkedAt: NOW - HOUR,
    items,
    counts: {
      all: items.length,
      datasource: items.filter((item) => item.kind === "datasource").length,
      panel: items.filter((item) => item.kind === "panel").length,
    },
    revoked: [],
  });
}
