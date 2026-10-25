import { describe, expect, it } from "vitest";
import type { DatasourceSummary } from "./api";
import { initials } from "./DataSourceDrawer";
import {
  filterSources,
  type HealthEntry,
  isFiltered,
  kindGroup,
  median,
  NO_FILTER,
  type SourceStatus,
  statusOf,
} from "./sourceStatus";

const entry = (part: Partial<HealthEntry>): HealthEntry => ({
  health: undefined,
  error: null,
  pending: false,
  ...part,
});

describe("source status", () => {
  it("follows the last test", () => {
    expect(statusOf(undefined)).toBe("untested");
    expect(statusOf(entry({ pending: true }))).toBe("testing");
    expect(statusOf(entry({ error: new Error("x") }))).toBe("unreachable");
    expect(statusOf(entry({ health: { ok: false, message: "", latencyMs: 3 } }))).toBe(
      "unreachable",
    );
    expect(statusOf(entry({ health: { ok: true, message: "", latencyMs: 499 } }))).toBe(
      "connected",
    );
    expect(statusOf(entry({ health: { ok: true, message: "", latencyMs: 500 } }))).toBe("slow");
  });

  it("groups kinds as the filter shows them", () => {
    expect(kindGroup("postgres")).toBe("tables");
    expect(kindGroup("sqlite")).toBe("tables");
    expect(kindGroup("prometheus")).toBe("metrics");
    expect(kindGroup("elasticsearch")).toBe("documents");
    expect(kindGroup("mongodb")).toBe("documents");
    expect(kindGroup("neo4j")).toBe("graphs");
    expect(kindGroup("http_json")).toBe("apis");
    expect(kindGroup("file")).toBe("files");
    expect(kindGroup("something-new")).toBe("other");
  });

  it("takes the middle value, or the mean of the two middle ones", () => {
    expect(median([])).toBeNull();
    expect(median([30, 10, 20])).toBe(20);
    expect(median([40, 10, 20, 30])).toBe(25);
  });

  it("makes initials from one or two words", () => {
    expect(initials("Vertrieb")).toBe("VE");
    expect(initials("Data Team")).toBe("DT");
    expect(initials("  ")).toBe("");
  });
});

describe("filtering sources", () => {
  const source = (id: string, name: string, kind: string, createdAt: number) =>
    ({ id, name, kind, createdAt }) as DatasourceSummary;
  const items = [
    source("a", "shop", "postgres", 3),
    source("b", "Graph", "neo4j", 1),
    source("c", "Monitoring", "prometheus", 2),
    source("d", "events 10", "postgres", 4),
    source("e", "events 9", "postgres", 5),
  ];
  const statuses: Record<string, SourceStatus> = {
    a: "connected",
    b: "slow",
    c: "unreachable",
    d: "testing",
  };
  const status = (id: string) => statuses[id] ?? "untested";
  const kindName = (kind: string) => ({ postgres: "PostgreSQL" })[kind] ?? kind;
  const names = (filter: Partial<typeof NO_FILTER>) =>
    filterSources(items, { ...NO_FILTER, ...filter }, kindName, status, "en").map((s) => s.name);

  it("sorts by name with numbers in order and ignores case", () => {
    expect(names({})).toEqual(["events 9", "events 10", "Graph", "Monitoring", "shop"]);
  });

  it("finds by name, kind key or kind name", () => {
    expect(names({ search: "MONI" })).toEqual(["Monitoring"]);
    expect(names({ search: "postgresql" })).toEqual(["events 9", "events 10", "shop"]);
    expect(names({ search: "neo4" })).toEqual(["Graph"]);
  });

  it("filters by kind group and by status, a running test counting as untested", () => {
    expect(names({ group: "graphs" })).toEqual(["Graph"]);
    expect(names({ status: "untested" })).toEqual(["events 9", "events 10"]);
    expect(names({ status: "unreachable", group: "tables" })).toEqual([]);
  });

  it("puts problems first when sorting by status, and the newest first by date", () => {
    expect(names({ sort: "status" })).toEqual([
      "Monitoring",
      "Graph",
      "shop",
      "events 9",
      "events 10",
    ]);
    expect(names({ sort: "added" })).toEqual([
      "events 9",
      "events 10",
      "shop",
      "Monitoring",
      "Graph",
    ]);
  });

  it("knows when a filter is set; the sort order is not one", () => {
    expect(isFiltered(NO_FILTER)).toBe(false);
    expect(isFiltered({ ...NO_FILTER, sort: "status" })).toBe(false);
    expect(isFiltered({ ...NO_FILTER, search: " x " })).toBe(true);
  });
});
