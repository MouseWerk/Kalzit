import type { QueryClient } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import type { DatasourceAccess, DatasourceSummary } from "./api";
import { initials } from "./DataSourceDrawer";
import {
  filterSources,
  HEALTH_TTL_MS,
  type HealthEntry,
  healthEntry,
  isFiltered,
  kindGroup,
  median,
  NO_FILTER,
  needsAllPages,
  runHealthChecks,
  type SourceStatus,
  statusOf,
  testableIds,
} from "./sourceStatus";

const NOW = Date.UTC(2026, 9, 25, 12);

const entry = (part: Partial<HealthEntry>): HealthEntry => ({
  health: undefined,
  error: null,
  pending: false,
  at: NOW,
  ...part,
});

describe("source status", () => {
  const status = (part: Partial<HealthEntry>) => statusOf(entry(part), NOW);

  it("follows the last test", () => {
    expect(statusOf(undefined, NOW)).toBe("untested");
    expect(status({ pending: true, at: 0 })).toBe("testing");
    expect(status({ health: { ok: false, message: "", latencyMs: 3 } })).toBe("unreachable");
    expect(status({ health: { ok: true, message: "", latencyMs: 499 } })).toBe("connected");
    expect(status({ health: { ok: true, message: "", latencyMs: 500 } })).toBe("slow");
  });

  it("tells a refused or lost test request apart from an unreachable source", () => {
    expect(status({ error: new ApiError("forbidden", 403, "no") })).toBe("forbidden");
    expect(status({ error: new ApiError("network", 0, "offline") })).toBe("failed");
    expect(status({ error: new Error("x") })).toBe("failed");
  });

  it("counts an old result as untested again", () => {
    const ok = { ok: true, message: "", latencyMs: 10 };
    expect(status({ health: ok, at: NOW - HEALTH_TTL_MS })).toBe("connected");
    expect(status({ health: ok, at: NOW - HEALTH_TTL_MS - 1 })).toBe("untested");
  });

  it("reads an entry from a cached query, or none when it never ran", () => {
    const base = { data: undefined, error: null, dataUpdatedAt: 0, errorUpdatedAt: 0 };
    expect(healthEntry({ ...base, fetchStatus: "idle" })).toBeUndefined();
    expect(healthEntry({ ...base, fetchStatus: "fetching" })).toMatchObject({ pending: true });
    const error = new Error("x");
    expect(healthEntry({ ...base, error, errorUpdatedAt: 7, fetchStatus: "idle" })).toEqual({
      health: undefined,
      error,
      pending: false,
      at: 7,
    });
  });

  it("loads every page only while a filter or another sort is set", () => {
    expect(needsAllPages(NO_FILTER)).toBe(false);
    expect(needsAllPages({ ...NO_FILTER, search: "a" })).toBe(true);
    expect(needsAllPages({ ...NO_FILTER, sort: "added" })).toBe(true);
  });
});

describe("testing several sources", () => {
  const access = (query: boolean) => ({ read: true, query }) as DatasourceAccess;
  const items = ["a", "b", "c"].map((id) => ({ id, name: id }) as DatasourceSummary);

  it("skips sources without query access", () => {
    expect(testableIds(items, (source) => access(source.id !== "b"))).toEqual(["a", "c"]);
  });

  /** A query client whose tests wait until released, counting how many run at once. */
  function fakeClient() {
    let running = 0;
    let most = 0;
    const started: string[] = [];
    const waiting: (() => void)[] = [];
    const client = {
      fetchQuery: (options: { queryKey: readonly unknown[] }) => {
        started.push(String(options.queryKey[2]));
        running += 1;
        most = Math.max(most, running);
        return new Promise<void>((resolve) =>
          waiting.push(() => {
            running -= 1;
            resolve();
          }),
        );
      },
    } as unknown as Pick<QueryClient, "fetchQuery">;
    const releaseAll = async () => {
      while (waiting.length > 0) {
        for (const release of waiting.splice(0)) {
          release();
        }
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    };
    return { client, started, most: () => most, releaseAll };
  }

  it("runs at most four tests at once and tests each source once", async () => {
    const fake = fakeClient();
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const done = runHealthChecks(fake.client, "o1", ids);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fake.started).toHaveLength(4);
    await fake.releaseAll();
    await done;
    expect(fake.most()).toBe(4);
    expect([...fake.started].sort()).toEqual([...ids].sort());
  });

  it("starts no further test once cancelled", async () => {
    const fake = fakeClient();
    const controller = new AbortController();
    const ids = Array.from({ length: 10 }, (_, i) => `s${i}`);
    const done = runHealthChecks(fake.client, "o1", ids, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await fake.releaseAll();
    await done;
    expect(fake.started).toHaveLength(4);
  });
});

describe("kinds, medians and initials", () => {
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
