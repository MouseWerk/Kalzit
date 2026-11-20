import { describe, expect, it } from "vitest";
import type { AuditEvent } from "../features/admin/api";
import { knownAuditActions } from "../features/admin/catalog";
import type { SourceStatusItem } from "../features/datasources/api";
import { translate } from "../i18n/i18n";
import {
  changeText,
  STALE_MS,
  STATUS_ROWS,
  sinceText,
  statusRows,
  storedStatus,
} from "./StartCards";

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
  it("reads the status from the stored test: failing, slow, connected, stale or untested", () => {
    const now = 2;
    expect(storedStatus(source("a"), now)).toBe("untested");
    expect(storedStatus(source("a", { ok: false, warnings: [], testedAt: 1 }), now)).toBe(
      "unreachable",
    );
    expect(storedStatus(source("a", passed(840)), now)).toBe("slow");
    expect(storedStatus(source("a", passed(12)), now)).toBe("connected");
    // A test kept before latencies were stored still counts as connected.
    expect(storedStatus(source("a", passed()), now)).toBe("connected");
    // A day later the test no longer stands for the source, passed or failed.
    expect(storedStatus(source("a", passed(12)), 1 + STALE_MS + 1)).toBe("stale");
    expect(
      storedStatus(source("a", { ok: false, warnings: [], testedAt: 1 }), 1 + STALE_MS + 1),
    ).toBe("stale");
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
      2,
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

  it("words the alerting, report, share and provisioning changes as sentences too", () => {
    const report = { resourceType: "report", resourceId: "r1" };
    // The event's own record names what the server does not: also once it is deleted.
    expect(
      changeText(en, event({ ...report, action: "report.created", summary: { name: "Weekly" } })),
    ).toBe("Lea Hoffmann created the report “Weekly”");
    expect(
      changeText(de, event({ ...report, action: "report.deleted", summary: { name: "Woche" } })),
    ).toBe("Lea Hoffmann hat den Bericht „Woche“ gelöscht");
    expect(
      changeText(
        de,
        event({
          action: "alert_rule.paused",
          resourceType: "alert_rule",
          summary: { ruleId: "a1", name: "Umsatz zu niedrig" },
        }),
      ),
    ).toBe("Lea Hoffmann hat die Alert-Regel „Umsatz zu niedrig“ pausiert");
    expect(
      changeText(
        en,
        event({
          action: "alert_policy.moved",
          resourceType: "alert_policy",
          summary: { name: "Night shift" },
        }),
      ),
    ).toBe("Lea Hoffmann moved the policy “Night shift”");
    // A silence has no name; it still reads as a sentence.
    const silence = event({
      action: "alert_silence.created",
      resourceType: "alert_silence",
      summary: { silenceId: "s1", matchers: 2 },
    });
    expect(changeText(en, silence)).toBe("Lea Hoffmann created a silence");
    expect(changeText(de, silence)).toBe("Lea Hoffmann hat eine Stummschaltung angelegt");
    // A share is about a dashboard, which the server names where the reader may see it.
    const link = { action: "public_link.created", resourceType: "public_link" };
    expect(changeText(en, event({ ...link, resourceName: "Sales" }))).toBe(
      "Lea Hoffmann created a public link to “Sales”",
    );
    expect(changeText(de, event(link))).toBe(
      "Lea Hoffmann hat einen öffentlichen Link zu einem Dashboard erstellt",
    );
    expect(
      changeText(
        en,
        event({ action: "provisioning.applied", resourceType: "org", summary: { set: "prod" } }),
      ),
    ).toBe("Lea Hoffmann applied the provisioning files of the set “prod”");
    // Another resource's summary is not read as a name.
    expect(changeText(en, event({ summary: { name: "Other" } }))).toBe(
      "Lea Hoffmann: Dashboard saved",
    );
    // A recipient who unsubscribes is not signed in.
    expect(
      changeText(
        en,
        event({ ...report, action: "report.unsubscribed", actorName: null, summary: {} }),
      ),
    ).toBe("Someone unsubscribed from a report");
  });

  it("has a sentence in both languages for every alerting, report, share and provisioning action", () => {
    const areas = /^(alert_|alerting\.|report\.|public_link\.|snapshot\.|provisioning\.)/;
    const actions = knownAuditActions().filter((action) => areas.test(action));
    expect(actions.length).toBeGreaterThan(25);
    for (const action of actions) {
      for (const t of [en, de]) {
        const text = changeText(t, event({ action, resourceType: null, actorName: "Lea" }));
        expect(text, action).not.toContain(":");
        expect(text, action).toMatch(/^Lea /);
      }
    }
  });
});
