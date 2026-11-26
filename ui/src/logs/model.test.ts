import { describe, expect, it } from "vitest";
import {
  dedupe,
  dedupKey,
  fieldValue,
  type LogLine,
  logfmtFields,
  logSourceOf,
  logsOfferFor,
  resolveFields,
  sortLines,
  timeMs,
  toLogLines,
  valueShare,
  WHOLE_DOCUMENT,
} from "./model";

const date = (ms: number) => ({ $type: "date", value: String(ms) });

/** Loki's documents as the server answers a log query (docs/api/datasources.md, "Loki"). */
function lokiDoc(ms: number, line: string, labels: Record<string, string>) {
  return { time: date(ms), timestampNs: `${ms}000000`, line, labels };
}

describe("field mapping", () => {
  it("knows the source of a kind", () => {
    expect(logSourceOf("loki")).toBe("loki");
    expect(logSourceOf("elasticsearch")).toBe("search");
    expect(logSourceOf("mongodb")).toBe("documents");
  });

  it("reads Loki's time, line and level label, the level from the text where no label has it", () => {
    const docs = [
      lokiDoc(2_000, "payment declined order=48213", { app: "api", level: "error" }),
      lokiDoc(1_000, 'level=warn msg="slow"', { app: "web" }),
      lokiDoc(500, "health ok", { app: "web", detected_level: "info" }),
    ];
    const fields = resolveFields("loki", docs);
    expect(fields.time).toBe("time");
    expect(fields.text).toBe("line");
    const lines = toLogLines(docs, "loki", fields);
    expect(lines.map((line) => [line.timeMs, line.level, line.levelRaw])).toEqual([
      [2_000, "error", "error"],
      [1_000, "warning", "warn"],
      [500, "info", "info"],
    ]);
    expect(lines[0]?.labels.map((label) => [label.key, label.text])).toEqual([
      ["app", "api"],
      ["level", "error"],
    ]);
    // Fields of the line: logfmt pairs, or the keys of a JSON line.
    expect(lines[0]?.fields.map((field) => [field.key, field.text, field.origin])).toEqual([
      ["order", "48213", "line"],
    ]);
  });

  it("parses JSON lines into nested fields and keeps the text as it was", () => {
    const text = '{"msg":"order created","order":48212,"items":{"sku":"KL-20"}}';
    const [line] = toLogLines([lokiDoc(1, text, {})], "loki", resolveFields("loki", []));
    expect(line?.text).toBe(text);
    expect(line?.json).toEqual({ msg: "order created", order: 48212, items: { sku: "KL-20" } });
    expect(line?.fields.map((field) => field.key)).toEqual(["msg", "order", "items.sku"]);
  });

  it("reads Elasticsearch hits from _source by the query's time field, dotted keys included", () => {
    const docs = [
      {
        _index: "logs-1",
        _id: "a",
        _source: {
          "@timestamp": "2026-11-24T13:37:12.481Z",
          when: "2026-11-24T13:00:00Z",
          message: "db timeout",
          "log.level": "ERROR",
          host: "db-2",
        },
      },
    ];
    const auto = resolveFields("search", docs);
    expect(auto).toMatchObject({
      time: "_source.@timestamp",
      text: "_source.message",
      levels: ["_source.log.level"],
    });
    expect(resolveFields("search", docs, {}, "when").time).toBe("_source.when");
    const [line] = toLogLines(docs, "search", auto);
    expect(line?.timeMs).toBe(Date.parse("2026-11-24T13:37:12.481Z"));
    expect(line?.level).toBe("error");
    expect(line?.labels.map((label) => label.key)).toEqual(["_index", "_id"]);
    // The read fields are not listed again; the others are, by the name a filter uses.
    expect(line?.fields.map((field) => [field.key, field.path])).toEqual([
      ["when", "_source.when"],
      ["host", "_source.host"],
    ]);
  });

  it("finds a time and text in other documents by name, else any date; the choice overrides", () => {
    const docs = [
      { _id: 1, createdAt: date(5_000), action: "login", outcome: "denied", severity: "warn" },
      { _id: 2, createdAt: date(6_000), action: "logout", outcome: "ok" },
    ];
    const auto = resolveFields("documents", docs);
    expect(auto.time).toBe("createdAt");
    // No field named like a log line: the view asks instead of guessing.
    expect(auto.text).toBeNull();
    expect(auto.levels).toEqual(["severity"]);
    const chosen = resolveFields("documents", docs, { text: "action", level: "outcome" });
    expect(chosen).toMatchObject({ text: "action", levels: ["outcome"] });
    expect(chosen.auto).toEqual({ time: true, text: false, level: false });
    const lines = toLogLines(docs, "documents", chosen);
    expect(lines.map((line) => [line.text, line.level, line.levelRaw])).toEqual([
      ["login", "unknown", "denied"],
      ["logout", "unknown", "ok"],
    ]);
    // A date field under another name is still found as the time.
    expect(resolveFields("documents", [{ seen: date(1), msg: "x" }]).time).toBe("seen");
    expect(resolveFields("documents", [{ n: 1 }]).time).toBeNull();
  });

  it("offers the Logs tab first for Loki and for hits with time and text, else only offers it", () => {
    const hits = [{ _source: { "@timestamp": "2026-11-24T13:00:00Z", message: "x" } }];
    const sales = [{ _source: { "@timestamp": "2026-11-24T13:00:00Z", amount: 1 } }];
    expect(logsOfferFor("loki", resolveFields("loki", []))).toBe("preselect");
    expect(logsOfferFor("search", resolveFields("search", hits))).toBe("preselect");
    expect(logsOfferFor("search", resolveFields("search", sales))).toBe("offer");
    expect(logsOfferFor("documents", resolveFields("documents", [{ ts: date(1), msg: "a" }]))).toBe(
      "offer",
    );
    expect(logsOfferFor("documents", resolveFields("documents", [{ n: 1 }]))).toBe("none");
  });

  it("takes the whole document as one line on request", () => {
    const doc = { createdAt: date(1), action: "login" };
    const fields = resolveFields("documents", [doc], { text: WHOLE_DOCUMENT });
    const [line] = toLogLines([doc], "documents", fields);
    expect(line?.text).toBe(JSON.stringify(doc));
  });

  it("reads times in every common form", () => {
    expect(timeMs(date(1_700_000_000_000))).toBe(1_700_000_000_000);
    expect(timeMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(timeMs(1_700_000_000_000)).toBe(1_700_000_000_000);
    expect(timeMs(1_700_000_000_000_000)).toBe(1_700_000_000_000);
    expect(timeMs("1700000000000000000")).toBe(1_700_000_000_000);
    expect(timeMs("2026-11-24T13:37:12Z")).toBe(Date.parse("2026-11-24T13:37:12Z"));
    expect(timeMs("yesterday")).toBeNull();
    expect(timeMs({ $type: "objectId", value: "abc" })).toBeNull();
  });

  it("follows dotted paths through objects and dotted keys", () => {
    const doc = { a: { b: { c: 1 } }, "x.y": { z: 2 }, "p.q.r": 3 };
    expect(fieldValue(doc, "a.b.c")).toBe(1);
    expect(fieldValue(doc, "x.y.z")).toBe(2);
    expect(fieldValue(doc, "p.q.r")).toBe(3);
    expect(fieldValue(doc, "a.missing")).toBeUndefined();
  });

  it("reads logfmt with quoted values", () => {
    expect(logfmtFields('level=info msg="handled request 3817" status=200 empty=')).toEqual([
      ["level", "info"],
      ["msg", "handled request 3817"],
      ["status", "200"],
      ["empty", ""],
    ]);
  });
});

function line(id: number, text: string, ms: number | null = id, level = "info"): LogLine {
  return {
    id,
    document: {},
    timeMs: ms,
    text,
    level: level as LogLine["level"],
    levelRaw: level,
    labels: [],
    fields: [
      { key: "host", path: "host", value: `web-${id % 2}`, text: `web-${id % 2}`, origin: "line" },
    ],
    json: null,
  };
}

describe("order and duplicates", () => {
  it("sorts newest or oldest first and keeps lines without a time at the end", () => {
    const lines = [line(0, "a", 2), line(1, "b", null), line(2, "c", 3), line(3, "d", 1)];
    expect(sortLines(lines, "newest").map((l) => l.text)).toEqual(["c", "a", "d", "b"]);
    expect(sortLines(lines, "oldest").map((l) => l.text)).toEqual(["d", "a", "c", "b"]);
  });

  it("merges consecutive equal lines by the chosen mode", () => {
    const lines = [
      line(0, "POST /api/checkout 200 customer=3921 dauer_ms=212"),
      line(1, "POST /api/checkout 200 customer=3921 dauer_ms=212"),
      line(2, "POST /api/checkout 200 customer=4711 dauer_ms=640"),
      line(3, 'db timeout query="INSERT orders" nach_ms=5000'),
      line(4, 'db timeout query="UPDATE carts" nach_ms=4000'),
      line(5, "POST /api/checkout 200 customer=3921 dauer_ms=212"),
    ];
    const counts = (mode: Parameters<typeof dedupe>[1]) =>
      dedupe(lines, mode).map((group) => group.members.length);
    expect(counts("none")).toEqual([1, 1, 1, 1, 1, 1]);
    expect(counts("exact")).toEqual([2, 1, 1, 1, 1]);
    expect(counts("numbers")).toEqual([3, 1, 1, 1]);
    expect(counts("signature")).toEqual([3, 2, 1]);
  });

  it("never merges lines of different levels", () => {
    const a = line(0, "same text", 0, "info");
    const b = line(1, "same text", 1, "error");
    expect(dedupKey(a, "exact")).not.toBe(dedupKey(b, "exact"));
    expect(dedupe([a, b], "signature")).toHaveLength(2);
  });

  it("gives the share of loaded lines with the same value", () => {
    const lines = [line(0, "a"), line(1, "b"), line(2, "c"), line(3, "d")];
    const field = lines[0]?.fields[0];
    expect(field === undefined ? 0 : valueShare(lines, field)).toBe(0.5);
  });
});
