import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../features/admin/api";
import type { SourceStatusItem } from "../features/datasources/api";
import { translate } from "../i18n/i18n";
import { changeText, STATUS_ROWS, sinceText, statusRows, storedStatus } from "./StartCards";

const en = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("en", key, params);
const de = (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) =>
  translate("de", key, params);

function source(name: string, lastTest?: SourceStatusItem["lastTest"]): SourceStatusItem {
  return { id: name, name, kind: "postgres", ...(lastTest === undefined ? {} : { lastTest }) };
}

const passed = (latencyMs?: number) => ({
  ok: true,
  warnings: [],
  testedAt: 1,
  ...(latencyMs === undefined ? {} : { latencyMs }),
});

function event(fields: Partial<AuditEvent>): AuditEvent {
  return {
    id: "e1",
    orgId: "o1",
    actorUserId: "u1",
    actorName: "Lea Hoffmann",
    actorAddress: null,
    action: "dashboard.saved",
    resourceType: "dashboard",
    resourceId: "d1",
    summary: {},
    createdAt: 0,
    ...fields,
  };
}

describe("start page cards", () => {
  it("reads the status from the stored test: failing, slow, connected or untested", () => {
    expect(storedStatus(source("a"))).toBe("untested");
    expect(storedStatus(source("a", { ok: false, warnings: [], testedAt: 1 }))).toBe("unreachable");
    expect(storedStatus(source("a", passed(840)))).toBe("slow");
    expect(storedStatus(source("a", passed(12)))).toBe("connected");
    // A test kept before latencies were stored still counts as connected.
    expect(storedStatus(source("a", passed()))).toBe("connected");
  });

  it("lists problems first, then by name, a few at most", () => {
    const rows = statusRows(
      [
        source("Zeta", passed(5)),
        source("Alpha"),
        source("Monitoring", { ok: false, warnings: [], testedAt: 1 }),
        source("Graph", passed(900)),
        source("Beta", passed(5)),
      ],
      "en",
    ).map((item) => item.name);
    expect(rows).toEqual(["Monitoring", "Graph", "Beta", "Zeta", "Alpha"]);
    const many = Array.from({ length: STATUS_ROWS + 3 }, (_, index) => source(`S${index}`));
    expect(statusRows(many, "en")).toHaveLength(STATUS_ROWS);
  });

  it("says how long in the largest whole unit, in the dative in German", () => {
    const day = 86_400_000;
    expect(sinceText(en, "en", 8 * day)).toBe("1 week");
    expect(sinceText(de, "de", 8 * day)).toBe("1 Woche");
    expect(sinceText(de, "de", 3 * day)).toBe("3 Tagen");
    expect(sinceText(en, "en", 2 * 3_600_000)).toBe("2 hours");
    expect(sinceText(en, "en", 5_000)).toBe("1 minute");
  });

  it("words a change with what changed, and falls back without a name", () => {
    expect(changeText(de, event({ resourceName: "Umsatz nach Region" }))).toBe(
      "Lea Hoffmann hat „Umsatz nach Region“ gespeichert",
    );
    expect(
      changeText(
        de,
        event({ action: "datasource.updated", resourceType: "datasource", resourceName: "Shop" }),
      ),
    ).toBe("Lea Hoffmann hat die Datenquelle „Shop“ geändert");
    // Joining needs no resource name.
    expect(
      changeText(de, event({ action: "invitation.accepted", actorName: "Sofia Wagner" })),
    ).toBe("Sofia Wagner ist der Organisation beigetreten");
    // A resource the caller may not see, or one gone, keeps the action's label.
    expect(changeText(en, event({}))).toBe("Lea Hoffmann: Dashboard saved");
    expect(changeText(en, event({ action: "plugin.future", actorName: null }))).toBe(
      "Someone: plugin.future",
    );
  });
});
