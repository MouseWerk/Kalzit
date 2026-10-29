import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { checkOptions, effectiveOptions, type PanelOption, parsePanelOption } from "./options";
import { linkAllowed, MAX_EVENT_BYTES, parseEvent, parseEventText, RateLimit } from "./protocol";

/**
 * The host checks every event and every option exactly as `kalzit_plugin_api::panel` does: both
 * run the cases of the shared fixtures in plugin-api/panel/v1.
 */
const FIXTURES = resolve(import.meta.dirname, "../../../../../plugin-api/panel/v1");

interface EventCase {
  name: string;
  event?: unknown;
  raw?: string;
  code: string | null;
  passed?: unknown;
}

const events = (
  JSON.parse(readFileSync(resolve(FIXTURES, "events.fixture.json"), "utf8")) as {
    cases: EventCase[];
  }
).cases;

const options = JSON.parse(readFileSync(resolve(FIXTURES, "options.fixture.json"), "utf8")) as {
  options: unknown[];
  cases: { name: string; options: Record<string, unknown>; code: string | null }[];
};

describe("panel events", () => {
  it.each(events.map((c) => [c.name, c] as const))("%s", (_, c) => {
    const text =
      c.raw === "TOO_LARGE" ? "x".repeat(MAX_EVENT_BYTES + 1) : (c.raw ?? JSON.stringify(c.event));
    const parsed = parseEventText(text);
    if (c.code === null) {
      expect(parsed.ok, JSON.stringify(parsed)).toBe(true);
      if (parsed.ok && c.passed !== undefined) {
        expect({ kalzit: "panel", api: 1, ...parsed.event }).toEqual(c.passed);
      }
    } else {
      expect(parsed.ok ? null : parsed.code).toBe(c.code);
    }
  });

  it("checks what postMessage delivered as JSON: no prototypes, functions or cycles pass", () => {
    const cyclic: Record<string, unknown> = { kalzit: "panel", api: 1, type: "ready" };
    cyclic.self = cyclic;
    expect(parseEvent(cyclic)).toMatchObject({ ok: false, code: "panel.not_json" });
    expect(parseEvent({ kalzit: "panel", api: 1, type: "ready", f: () => 1 })).toEqual({
      ok: true,
      event: { type: "ready" },
    });
    // A multi-byte text counts in bytes, as the server's limit does.
    const big = "ü".repeat(MAX_EVENT_BYTES / 2);
    expect(
      parseEvent({ kalzit: "panel", api: 1, type: "log", level: "info", text: big }),
    ).toMatchObject({
      code: "panel.too_large",
    });
  });

  it("opens links only to the web or to Kalzit", () => {
    for (const good of [
      "https://example.com",
      "http://10.0.0.1:8080/x",
      "/d/abc",
      "HTTPS://Example.com/a",
    ]) {
      expect(linkAllowed(good), good).toBe(true);
    }
    for (const bad of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "file:///etc/passwd",
      "//evil.example",
      "/\\evil.example",
      "https://a@b.example",
      "https://:443/x",
      "ftp://example.com",
      "",
      // Format characters anywhere, as Rust's `panel::is_format` refuses them.
      "https://example.com‮moc.lapyap",
      "https://exa​mple.com/",
      "https://example.com/a‍b",
      "/d/abc⁦x",
      "https://﻿example.com",
      "https://exam­ple.com",
      "https://example.com/\u{e0041}",
    ]) {
      expect(linkAllowed(bad), bad).toBe(false);
    }
  });

  it("limits events per second", () => {
    let now = 5_000;
    const limit = new RateLimit(3, () => now);
    expect([limit.take(), limit.take(), limit.take(), limit.take()]).toEqual([
      true,
      true,
      true,
      false,
    ]);
    now = 5_999;
    expect(limit.take()).toBe(false);
    now = 6_000;
    expect(limit.take()).toBe(true);
  });
});

describe("panel options", () => {
  const declared = options.options.map((o) => parsePanelOption(o) as PanelOption);

  it("reads every declared option", () => {
    expect(declared.every((o) => o !== null)).toBe(true);
    expect(declared.map((o) => o.type)).toEqual([
      "string",
      "text",
      "integer",
      "number",
      "bool",
      "select",
    ]);
  });

  it.each(options.cases.map((c) => [c.name, c] as const))("%s", (_, c) => {
    expect(checkOptions(declared, c.options)?.code ?? null).toBe(c.code);
  });

  it("gives a panel only values that fit, with the defaults for the rest", () => {
    expect(effectiveOptions(declared, { field: "cpu", decimals: 99, colour: "red" })).toEqual({
      field: "cpu",
      decimals: 2,
      sparkline: true,
      mode: "last",
    });
    expect(effectiveOptions(declared, "not an object")).toEqual({
      decimals: 2,
      sparkline: true,
      mode: "last",
    });
  });
});
