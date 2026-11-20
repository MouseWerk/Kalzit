import { screen, waitFor, within } from "@testing-library/react";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import type { Provisioned } from "../../api/generated/shapes";
import { translate } from "../../i18n/i18n";
import type { installFakeServer } from "../../test/fakeServer";
import { openAdmin } from "../admin/test/openAdmin";
import { emptyModel, type PanelModel } from "../dashboards/model";
import { addDashboard } from "../dashboards/test/fakeDashboards";
import { errorMessage } from "../dashboards/ui/errors";
import { PG_ID } from "../datasources/test/fakeDatasources";
import { readGrafana, suggestSource, withTitle } from "./grafana";
import { noticeKey, parseNotice } from "./importNotice";
import { isLocked } from "./Managed";
import { driftOf, PATH_TAIL, splitPath } from "./ProvisioningPage";
import { FAKE_REPORT, fakeProvisioned } from "./test/fakeProvisioning";

const t = (key: Parameters<typeof translate>[1], params?: Record<string, string | number>) =>
  translate("en", key, params ?? {});

const orders: PanelModel = {
  id: "p1",
  type: "table",
  title: "Orders",
  grid: { x: 0, y: 0, w: 12, h: 8 },
  targets: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM orders" } }],
  transformations: [],
  options: {},
  fieldConfig: {},
};

const ADMIN = [
  "dashboards:read",
  "dashboards:write",
  "dashboards:delete",
  "datasources:query",
  "datasources:read",
  "folders:read",
  "roles:read",
  "roles:write",
  "audit:read",
  "provisioning:read",
  "provisioning:write",
];

type Server = ReturnType<typeof installFakeServer>;

function withDashboard(server: Server) {
  addDashboard(server.areas.dashboards, "d-main", { ...emptyModel("Main"), panels: [orders] });
}

// Grafana writes an export's inputs and data source variables as "${NAME}"; put together here,
// so nothing reads them as a template of this file.
const DS_PROM = `$${"{DS_PROM}"}`;
const DS_VARIABLE = `$${"{ds}"}`;

const GRAFANA = {
  title: "Lager",
  schemaVersion: 39,
  __inputs: [{ name: "DS_PROM", label: "Prometheus Main", pluginName: "Prometheus" }],
  templating: {
    list: [
      { name: "host", type: "query", datasource: { type: "prometheus", uid: DS_PROM } },
      { name: "ds", type: "datasource" },
    ],
  },
  annotations: { list: [{ builtIn: 1, name: "Annotations & Alerts" }] },
  panels: [
    {
      id: 1,
      type: "timeseries",
      title: "CPU",
      datasource: { type: "prometheus", uid: DS_PROM },
      targets: [
        { refId: "A", expr: "up" },
        { refId: "B", expr: "rate(x[5m])" },
      ],
    },
    {
      id: 2,
      type: "row",
      title: "Lager",
      panels: [
        {
          id: 3,
          type: "table",
          title: "Bestand",
          datasource: { type: "postgres", uid: "pg-lager" },
          targets: [{ refId: "A", rawSql: "SELECT 1" }],
        },
      ],
    },
    {
      id: 4,
      type: "stat",
      title: "Per variable",
      datasource: { type: "prometheus", uid: DS_VARIABLE },
      targets: [{ refId: "A", expr: "up" }],
    },
    { id: 5, type: "text", title: "Hinweise" },
    {
      id: 6,
      type: "timeseries",
      title: "Mixed",
      datasource: { type: "datasource", uid: "-- Mixed --" },
      targets: [
        { refId: "A", datasource: { type: "postgres", uid: "pg-lager" }, rawSql: "SELECT 2" },
      ],
    },
  ],
};

// The badge, the import pages and their texts load on first use; loaded here, no test waits on
// a cold module.
beforeAll(async () => {
  await Promise.all([import("./ManagedBadge"), import("./ImportReport")]);
});

describe("reading a Grafana file", () => {
  it("counts what the file holds and names its data sources by the mapping's keys", () => {
    const file = readGrafana(JSON.stringify(GRAFANA));
    if (typeof file === "string") throw new Error(file);
    expect(file).toMatchObject({
      title: "Lager",
      schemaVersion: 39,
      panels: 5,
      rows: 1,
      variables: 2,
      annotations: 0,
    });
    expect(file.sources).toEqual([
      // An export's input: keyed as written, shown by its label; one use per panel and variable.
      { key: DS_PROM, label: "Prometheus Main", type: "prometheus", uses: 2, variable: false },
      { key: "pg-lager", label: "pg-lager", type: "postgres", uses: 2, variable: false },
      // A variable that picks the source becomes a fixed one.
      { key: DS_VARIABLE, label: DS_VARIABLE, type: "prometheus", uses: 1, variable: true },
    ]);
  });

  it("reads a wrapped export and renames the dashboard inside it", () => {
    const wrapped = { meta: {}, dashboard: { title: "Old", panels: [] } };
    const file = readGrafana(JSON.stringify(wrapped));
    expect(typeof file === "string" ? file : file.title).toBe("Old");
    expect(withTitle(wrapped, "New")).toEqual({
      meta: {},
      dashboard: { title: "New", panels: [] },
    });
    expect(withTitle({ title: "Old", panels: [] }, "New")).toEqual({ title: "New", panels: [] });
  });

  it("says what is wrong with a file it cannot take", () => {
    expect(readGrafana('{ "panels": [ }')).toBe("json");
    expect(readGrafana('{ "name": "prom", "type": "prometheus" }')).toBe("notDashboard");
    expect(readGrafana("[]")).toBe("notDashboard");
  });

  it("proposes the source of the same name, else the only one of its kind", () => {
    const available = [
      { id: "a", kind: "prometheus", name: "Prometheus Prod" },
      { id: "b", kind: "postgres", name: "Lager PG" },
      { id: "c", kind: "postgres", name: "pg-lager" },
    ];
    const source = (patch: object) => ({
      key: "k",
      label: "",
      type: "",
      uses: 1,
      variable: false,
      ...patch,
    });
    expect(suggestSource(source({ label: "prom-main", type: "prometheus" }), available)).toEqual({
      id: "a",
      why: "sameKind",
    });
    expect(suggestSource(source({ label: "PG-Lager", type: "postgres" }), available)).toEqual({
      id: "c",
      why: "sameName",
    });
    // Two of the kind and no name in common: people pick.
    expect(suggestSource(source({ label: "other", type: "postgres" }), available)).toEqual({
      id: "",
      why: "none",
    });
    expect(suggestSource(source({ label: "az", type: "azure" }), available).why).toBe("none");
  });
});

describe("provisioning records", () => {
  const record = (patch: Record<string, unknown> = {}) =>
    fakeProvisioned(patch) as unknown as Provisioned;

  it("locks a managed resource until it is unlocked", () => {
    expect(isLocked(undefined)).toBe(false);
    expect(isLocked(record())).toBe(true);
    expect(isLocked(record({ unlockedAt: 1 }))).toBe(false);
  });

  it("names how a record differs from its file, the unlock first", () => {
    expect(driftOf(record())).toBeNull();
    expect(driftOf(record({ drifted: true }))).toBe("drifted");
    expect(driftOf(record({ missing: true, drifted: true }))).toBe("missing");
    expect(driftOf(record({ unlockedAt: 1, drifted: true }))).toBe("unlocked");
  });

  it("says why a change was refused: the set and the file to change instead", () => {
    const refusal = new ApiError("conflict", 409, "server text", undefined, {
      error: {
        code: "conflict",
        message: "server text",
        reason: "provisioning.read_only",
        params: {
          kind: "dashboard",
          set: "kalzit-config",
          uid: "main",
          path: "dashboards/main.yaml",
        },
      },
    });
    const text = errorMessage(t, refusal);
    expect(text).toContain("kalzit-config");
    expect(text).toContain("dashboards/main.yaml");
    expect(text).toContain("kalzit provision apply");
  });

  it("keeps the notice of an import only while it is well formed", () => {
    expect(noticeKey("d1")).toBe("kalzit.imported.d1");
    expect(parseNotice(null)).toBeNull();
    expect(parseNotice("")).toBeNull();
    expect(parseNotice("{")).toBeNull();
    expect(parseNotice('{"at":1,"converted":2,"approximated":1,"skipped":0}')).toEqual({
      at: 1,
      converted: 2,
      approximated: 1,
      skipped: 0,
    });
  });
});

describe("a dashboard managed by files", () => {
  function open(permissions = ADMIN, patch: Record<string, unknown> = {}) {
    return openAdmin("/dashboards/d-main", {
      permissions,
      setupServer: (server) => {
        withDashboard(server);
        server.areas.provisioning.resources.push(fakeProvisioned(patch));
      },
    });
  }

  it("is marked and read-only: Edit stays, locked, with the reason", async () => {
    const { user } = await open();
    const badge = await screen.findByRole("button", { name: "Managed by files" });
    const edit = screen.getByRole("button", { name: "Edit" });
    expect(edit.getAttribute("aria-disabled")).toBe("true");
    const reason = document.getElementById(edit.getAttribute("aria-describedby") ?? "");
    expect(reason?.textContent).toBe(t("dashboards.managedLocked"));
    // A click does not start editing.
    await user.click(edit);
    expect(screen.queryByRole("button", { name: "Save" })).toBeNull();

    // The field names set, file and last apply; Escape closes it and returns the focus.
    expect(badge.getAttribute("aria-expanded")).toBe("false");
    await user.click(badge);
    const field = screen.getByRole("dialog", { name: "Managed by files" });
    expect(badge.getAttribute("aria-expanded")).toBe("true");
    expect(field.textContent).toContain("dashboards/vertrieb/main.yaml");
    expect(field.textContent).toContain("kalzit-config");
    expect(within(field).getByText(t("provisioning.outside.dashboard"))).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog", { name: "Managed by files" })).toBeNull();
    expect(document.activeElement).toBe(badge);

    // The server refuses to trash a managed dashboard, so the menu does not offer it.
    await user.click(screen.getByRole("button", { name: "More" }));
    const menu = screen.getByRole("menu", { name: "More" });
    expect(within(menu).getByRole("menuitem", { name: t("dashboards.versions") })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: t("dashboards.delete") })).toBeNull();
  });

  it("is unlocked by an organization admin after a question, and can be edited then", async () => {
    const { user, server } = await open();
    await user.click(await screen.findByRole("button", { name: "Managed by files" }));
    await user.click(screen.getByRole("button", { name: "Unlock…" }));
    const ask = await screen.findByRole("alertdialog", { name: "Unlock “Main”?" });
    expect(document.activeElement).toBe(within(ask).getByRole("button", { name: "Cancel" }));
    expect(ask.textContent).toContain(t("provisioning.unlock.overwrite"));
    await user.click(within(ask).getByRole("button", { name: "Unlock" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(server.areas.provisioning.requests.at(-1)?.route).toBe(
      "/api/orgs/o1/provisioning/resources/dashboard/main-board/unlock",
    );
    expect(await screen.findByRole("button", { name: "From files, unlocked" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Edit" }).getAttribute("aria-disabled")).toBeNull(),
    );
  });

  it("offers no unlock without provisioning:write", async () => {
    const { user } = await open(ADMIN.filter((permission) => permission !== "provisioning:write"));
    await user.click(await screen.findByRole("button", { name: "Managed by files" }));
    expect(screen.queryByRole("button", { name: "Unlock…" })).toBeNull();
  });

  it("asks nothing of the server for people who may not read the sets", async () => {
    const { server } = await open(["dashboards:read", "dashboards:write", "datasources:query"]);
    await screen.findByRole("button", { name: "Edit" });
    expect(screen.queryByRole("button", { name: "Managed by files" })).toBeNull();
    expect(server.calls.some((call) => call.path.includes("/provisioning/"))).toBe(false);
  });
});

describe("managed roles", () => {
  it("marks a role from files in the list and keeps its permissions read-only", async () => {
    // The fake's own custom role "Auditor" (r1) comes from a file here.
    const { user } = await openAdmin("/admin/roles", {
      permissions: ADMIN,
      setupServer: (server) => {
        server.areas.provisioning.resources.push(
          fakeProvisioned({
            kind: "role",
            uid: "auditor",
            resourceId: "r1",
            name: "Auditor",
            path: "roles/auditor.yaml",
          }),
        );
      },
    });
    const row = (await screen.findByRole("link", { name: "Auditor" })).closest("li");
    expect(row).not.toBeNull();
    expect(await within(row as HTMLElement).findByRole("button", { name: "File" })).toBeTruthy();
    // No delete for a role its file owns.
    expect(within(row as HTMLElement).queryByRole("button", { name: /Delete/ })).toBeNull();
    await user.click(screen.getByRole("link", { name: "Auditor" }));
    expect(await screen.findByRole("button", { name: "Managed by files" })).toBeTruthy();
    const box = await screen.findByRole("checkbox", { name: "audit:read" });
    expect((box as HTMLInputElement).disabled).toBe(true);
  });

  it("offers dashboards:public in the role editor, with what it allows", async () => {
    await openAdmin("/admin/roles/new", { permissions: ADMIN.concat("dashboards:public") });
    const box = await screen.findByRole("checkbox", { name: "dashboards:public" });
    expect(box.closest("label, li, div")?.textContent).toContain(
      t("admin.permission.dashboards.public"),
    );
  });
});

describe("Verwaltung > Provisioning", () => {
  it("lists sets, managed resources, drift and the applies of the audit log", async () => {
    await openAdmin("/admin/provisioning", {
      permissions: ADMIN,
      setup: (admin) => {
        admin.audit.unshift({
          id: "a-apply",
          orgId: "o1",
          actorUserId: "u9",
          actorName: "ci-provisioning",
          actorAddress: null,
          action: "provisioning.applied",
          resourceType: "org",
          resourceId: "o1",
          summary: {
            set: "kalzit-config",
            prune: true,
            create: 1,
            update: 4,
            delete: 0,
            drifted: 1,
          },
          createdAt: Date.UTC(2026, 10, 14, 10, 42),
        } as (typeof admin.audit)[number]);
      },
      setupServer: (server) => {
        server.areas.provisioning.resources.push(
          fakeProvisioned(),
          fakeProvisioned({
            kind: "alertRule",
            uid: "api-latenz",
            resourceId: "r1",
            name: "API Latenz",
            path: "alerts/api-latenz.yaml",
            unlockedAt: Date.UTC(2026, 10, 14, 10, 44),
          }),
          fakeProvisioned({
            kind: "datasource",
            uid: "lager",
            resourceId: "ds-gone",
            name: "",
            path: "datasources/lager.yaml",
            missing: true,
          }),
        );
      },
    });
    expect(await screen.findByRole("heading", { level: 1, name: "Provisioning" })).toBeTruthy();
    const drift = await screen.findByRole("region", { name: "Drift" });
    expect(drift.textContent).toContain("API Latenz");
    expect(drift.textContent).toContain("unlocked");
    expect(drift.textContent).toContain("alerts/api-latenz.yaml");
    expect(drift.textContent).toContain("missing");
    // The apply as the audit log has it: who, the set, the changes in signs, and the prune.
    const applies = await screen.findByRole("region", { name: "Applies" });
    const row = await within(applies).findByRole("row", { name: /ci-provisioning/ });
    expect(row.textContent).toContain("kalzit-config");
    expect(row.textContent).toContain("+1 ~4 −0");
    expect(row.textContent).toContain("applied, with --prune");
    // Only a resource in step with its file can be unlocked from here.
    const resources = screen.getByRole("region", { name: "Managed resources" });
    expect(within(resources).getAllByRole("button", { name: /^Unlock/ })).toHaveLength(1);
    expect(within(resources).getByRole("link", { name: "Main" }).getAttribute("href")).toBe(
      "/dashboards/d-main",
    );
  });

  it("counts the sets and names the last one, and keeps each file path on one line", async () => {
    const path = "dashboards/regionen/regionen-aus-dateien-mit-langem-namen.json";
    await openAdmin("/admin/provisioning", {
      permissions: ADMIN,
      setupServer: (server) => {
        server.areas.provisioning.resources.push(
          fakeProvisioned(),
          fakeProvisioned({
            set: "regionen",
            uid: "regionen",
            resourceId: "d-regionen",
            name: "Regionen",
            path,
            appliedAt: Date.UTC(2026, 10, 15, 9, 0),
          }),
        );
      },
    });
    const sets = (await screen.findByText("Sets")).closest("li");
    expect(sets?.querySelector(".admin-sa-stat__value")?.textContent).toBe("2");
    expect(sets?.querySelector(".admin-sa-stat__note")?.textContent).toBe("last: regionen");
    // The names are in the filter of the list, not in the tile.
    expect(sets?.textContent).not.toContain("kalzit-config");
    const resources = screen.getByRole("region", { name: "Managed resources" });
    const chip = within(resources).getByTitle(path);
    // Cut in the middle: the start can shrink, the file name stays; the text reads whole.
    expect(chip.textContent).toBe(path);
    expect(chip.querySelector(".prov-path__tail")?.textContent).toBe(
      "regionen-aus-dateien-mit-langem-namen.json".slice(-PATH_TAIL),
    );
  });

  it("splits a path before its file name, or before its last characters", () => {
    expect(splitPath("dashboards/vertrieb/main.yaml")).toEqual([
      "dashboards/vertrieb/",
      "main.yaml",
    ]);
    expect(splitPath("main.yaml")).toEqual(["", "main.yaml"]);
    const long = "a/ein-sehr-langer-dateiname-ohne-ende.json";
    const [head, tail] = splitPath(long);
    expect(head + tail).toBe(long);
    expect(tail).toHaveLength(PATH_TAIL);
  });

  it("keeps no more of a file name than fits the narrowest chip", () => {
    // 24 characters: longer than the chip at 1024 px holds, so only its end stays whole.
    expect(splitPath("dashboards/vertrieb-uebersicht.yaml")).toEqual([
      "dashboards/vertrieb",
      "-uebersicht.yaml",
    ]);
    // 17 characters, one too many; 16 still stay whole.
    expect(splitPath("d/abcdefghijkl.yaml")).toEqual(["d/a", "bcdefghijkl.yaml"]);
    expect(splitPath("d/bcdefghijkl.yaml")).toEqual(["d/", "bcdefghijkl.yaml"]);
    // Counted in characters, not UTF-16 units: none is cut in half.
    const [head, tail] = splitPath("d/\u{1F4C8}\u{1F4C8}umsatz-ost.yaml");
    expect(head).toBe("d/\u{1F4C8}");
    expect(Array.from(tail)).toHaveLength(PATH_TAIL);
    expect(tail.startsWith("\u{1F4C8}")).toBe(true);
  });

  it("shows how to start while nothing comes from files", async () => {
    await openAdmin("/admin/provisioning", { permissions: ADMIN });
    expect(await screen.findByRole("heading", { name: "Nothing from files yet" })).toBeTruthy();
    // The first commands, ready to copy, with this server and organization.
    expect(document.querySelector("pre")?.textContent).toContain(
      "kalzit provision export ./kalzit-config --server http://localhost:3000 --org o1",
    );
  });

  it("is closed without provisioning:read", async () => {
    await openAdmin("/admin/provisioning", { permissions: ["roles:read"] });
    expect(await screen.findByRole("heading", { name: "No access" })).toBeTruthy();
  });
});

describe("the Grafana import", () => {
  it("leads through file, data sources and report, and creates nothing before the end", async () => {
    const { user, server, location } = await openAdmin("/dashboards/import/grafana", {
      permissions: ADMIN,
    });
    const steps = await screen.findByRole("list", { name: "Steps of the import" });
    expect(within(steps).getByText("File").closest("li")?.getAttribute("aria-current")).toBe(
      "step",
    );

    // A broken file says what is wrong, in plain words.
    await user.click(screen.getByRole("radio", { name: "Paste JSON" }));
    const json = screen.getByRole("textbox", { name: "JSON text" });
    await user.click(json);
    await user.paste('{ "panels": [ }');
    await user.click(screen.getByRole("button", { name: "Read JSON" }));
    expect(screen.getByText(t("provisioning.import.notJson"))).toBeTruthy();
    expect((screen.getByRole("button", { name: "Next" }) as HTMLButtonElement).disabled).toBe(true);

    await user.clear(json);
    await user.click(json);
    await user.paste(JSON.stringify(GRAFANA));
    await user.click(screen.getByRole("button", { name: "Read JSON" }));
    expect(screen.getByText("Grafana dashboard “Lager”")).toBeTruthy();
    expect(screen.getByText("Panels: 5, rows: 1")).toBeTruthy();
    const name = screen.getByLabelText("Dashboard name");
    await user.clear(name);
    await user.type(name, "Lager neu");
    await user.click(screen.getByRole("button", { name: "Next" }));

    // Step 2: each source of the file gets a Kalzit source, or is left out.
    const heading = await screen.findByRole("heading", { name: "Map the data sources" });
    expect(document.activeElement).toBe(heading);
    expect(within(steps).getByText("File").closest("li")?.textContent).toContain("done");
    expect(screen.getByRole("row", { name: /Prometheus Main/ })).toBeTruthy();
    expect(screen.getByRole("row", { name: /\$\{ds\}/ }).textContent).toMatch(
      /no fitting source|is left out|becomes fixed|proposed/,
    );
    expect(server.areas.provisioning.requests).toHaveLength(0);
    await user.click(screen.getByRole("button", { name: "See what changes" }));

    // Step 3: the report of a dry run; the name typed goes along, nothing is saved yet.
    await screen.findByRole("heading", { name: "What becomes of “Lager neu”" });
    const dry = server.areas.provisioning.requests.at(-1);
    expect(dry?.body.dryRun).toBe(true);
    expect(dry?.body.dashboard).toMatchObject({ title: "Lager neu" });
    const skipped = screen.getByRole("row", { name: /Standorte/ });
    expect(skipped.textContent).toContain("grafana-worldmap-panel");
    // Converted items are folded away until asked for.
    expect(screen.queryByRole("row", { name: /panel 1 "Durchsatz"/ })).toBeNull();
    await user.click(screen.getByRole("radio", { name: "All" }));
    expect(screen.getByRole("row", { name: /panel 1 "Durchsatz"/ })).toBeTruthy();
    expect(screen.getByText("Panels to create outside every folder: 2")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-imported"));
    expect(server.areas.provisioning.requests.at(-1)?.body.dryRun).toBe(false);
    // The new dashboard keeps a line that leads to the report, until it is put away.
    expect(parseNotice(window.localStorage.getItem(noticeKey("d-imported")))).toMatchObject({
      converted: 1,
      approximated: 1,
      skipped: 1,
    });
  });

  it("shows the line on the imported dashboard, which leads to the kept report", async () => {
    const { user, location } = await openAdmin("/dashboards/d-main", {
      permissions: ADMIN,
      setupServer: (server) => {
        withDashboard(server);
        server.areas.provisioning.reports["d-main"] = {
          source: "grafana",
          sourceVersion: 39,
          report: FAKE_REPORT,
          createdAt: Date.UTC(2026, 10, 14, 10, 42),
          createdBy: "u1",
        };
        window.localStorage.setItem(
          noticeKey("d-main"),
          JSON.stringify({ at: Date.UTC(2026, 10, 14), converted: 1, approximated: 1, skipped: 1 }),
        );
      },
    });
    const line = await screen.findByText(/Imported from Grafana on/);
    expect(line.textContent).toContain("Panels created: 2, of them approximated: 1, left out: 1.");
    await user.click(screen.getByRole("link", { name: "See the report" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-main/import-report"));
    expect(await screen.findByRole("heading", { level: 1, name: "Import report" })).toBeTruthy();
    expect(await screen.findByRole("row", { name: /Standorte/ })).toBeTruthy();
  });

  it("puts the line away for good", async () => {
    const { user } = await openAdmin("/dashboards/d-main", {
      permissions: ADMIN,
      setupServer: (server) => {
        withDashboard(server);
        window.localStorage.setItem(
          noticeKey("d-main"),
          JSON.stringify({ at: 1, converted: 1, approximated: 0, skipped: 0 }),
        );
      },
    });
    await user.click(await screen.findByRole("button", { name: "Hide" }));
    expect(screen.queryByText(/Imported from Grafana on/)).toBeNull();
    expect(parseNotice(window.localStorage.getItem(noticeKey("d-main")))).toBeNull();
  });
});
