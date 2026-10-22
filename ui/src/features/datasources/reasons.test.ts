import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { catalogs, type MessageKey, translate } from "../../i18n/i18n";
import { errorMessage } from "../dashboards/ui/errors";
import { noticeText, reasonText } from "./reasons";

/** The rows of the "Reasons" tables in docs/api/datasources.md: codes and their params. */
function documentedReasons(): Map<string, Set<string>> {
  const doc = readFileSync(
    resolve(import.meta.dirname, "../../../../docs/api/datasources.md"),
    "utf8",
  );
  const start = doc.indexOf("\n## Reasons");
  const end = doc.indexOf("\n## ", start + 1);
  const reasons = new Map<string, Set<string>>();
  // "Every reason here has the param `field`", says the settings section of the docs.
  let everyHasField = false;
  for (const line of doc.slice(start, end).split("\n")) {
    if (line.startsWith("### ")) {
      everyHasField = false;
    }
    if (/^Every reason here has the param `field`/.test(line)) {
      everyHasField = true;
    }
    const cells = line.split("|").map((cell) => cell.trim());
    const [, codes, params] = cells;
    if (codes === undefined || !codes.startsWith("`")) {
      continue;
    }
    const names = new Set([...(params ?? "").matchAll(/`(\w+)`/g)].map(([, name]) => name ?? ""));
    if (everyHasField) {
      names.add("field");
    }
    for (const [, code] of codes.matchAll(/`([\w.]+)`/g)) {
      reasons.set(code ?? "", names);
    }
  }
  return reasons;
}

const PREFIX = "datasources.reason.";
const documented = documentedReasons();
const t = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("en", key, params);
const de = (key: MessageKey, params?: Record<string, string | number>) =>
  translate("de", key, params);

describe("reason texts", () => {
  it("reads the documented reasons", () => {
    // About 130 in M1; a parser that finds a handful would pass the checks below for nothing.
    expect(documented.size).toBeGreaterThan(120);
    expect(documented.get("target.sqlite_path_refused")).toEqual(new Set());
    expect(documented.get("settings.required")).toEqual(new Set(["field"]));
    expect(documented.get("secrets.resend_on_target_change")).toEqual(new Set(["field", "secret"]));
    expect(documented.has("sql.unclosed_dollar_quote")).toBe(true);
  });

  it.each([...documented.keys()])("has a German and an English text for %s", (reason) => {
    const key = `${PREFIX}${reason}`;
    expect(Object.hasOwn(catalogs.en, key), `en: ${key}`).toBe(true);
    expect(Object.hasOwn(catalogs.de, key), `de: ${key}`).toBe(true);
  });

  it("has no reason text without a documented reason", () => {
    for (const catalog of [catalogs.en, catalogs.de]) {
      const left = Object.keys(catalog)
        .filter((key) => key.startsWith(PREFIX))
        .map((key) => key.slice(PREFIX.length))
        .filter((reason) => !documented.has(reason));
      expect(left).toEqual([]);
    }
  });

  it.each([...documented])("uses only documented params in %s", (reason, params) => {
    for (const catalog of [catalogs.en, catalogs.de]) {
      const text = catalog[`${PREFIX}${reason}` as MessageKey] ?? "";
      for (const [, name] of text.matchAll(/\{(\w+)\}/g)) {
        expect(params.has(name ?? ""), `${reason}: {${name}}`).toBe(true);
      }
    }
  });

  it("fills params, in German with du", () => {
    expect(
      reasonText(de, { reason: "settings.out_of_range", params: { min: "1", max: "3600" } }),
    ).toBe("Gib einen Wert von 1 bis 3600 ein.");
    expect(reasonText(de, { reason: "target.sqlite_path_refused" })).toMatch(
      /^Kalzit darf diese Datei nicht öffnen/,
    );
  });

<<<<<<< HEAD
  it("names the types of analysis reasons in the UI's words", () => {
    const params = { operator: "*", left: "text", right: "number" };
    expect(reasonText(de, { reason: "expression.operand_types", params })).toBe(
      "„*“ kann Text und Zahl nicht verbinden.",
    );
    expect(
      reasonText(de, {
        reason: "expression.argument_type",
        params: { name: "min", position: "1", expected: "a number, text or time", found: "bool" },
      }),
    ).toBe(
      "Wert 1 von „min“ muss eine Zahl, ein Text oder eine Zeit sein, nicht wahr oder falsch.",
    );
    expect(
      reasonText(t, { reason: "steps.key_types", params: { left: "int64", right: "string" } }),
    ).toBe("Fields of type whole number and text cannot be matched.");
  });

=======
>>>>>>> origin/main
  it("says “at least” for a range without an upper bound", () => {
    expect(reasonText(t, { reason: "settings.out_of_range", params: { min: "1" } })).toBe(
      "Enter a value of at least 1.",
    );
  });

  it("names the address of a metadata target, whichever param the server sent", () => {
    expect(
      reasonText(t, { reason: "target.metadata_address", params: { address: "169.254.169.254" } }),
    ).toMatch(/to 169\.254\.169\.254:/);
  });

  it("falls back to the server's English text for a reason it does not know", () => {
    expect(reasonText(t, { reason: "future.reason", fallback: "something new" })).toBe(
      "something new",
    );
    expect(reasonText(t, { reason: "future.reason" })).toBeUndefined();
    expect(noticeText(t, { severity: "info", code: "future.notice", text: "fyi" })).toBe("fyi");
  });

  it("prefers the reason over the error code, and the code when there is no reason", () => {
    const refused = new ApiError("datasource_target_blocked", 422, "refused", "path", {
      error: {
        code: "datasource_target_blocked",
        message: "refused",
        reason: "target.not_allowed",
        params: { host: "db.example" },
      },
    });
    expect(errorMessage(t, refused)).toBe(
      "The server admin has not allowed connections to db.example.",
    );
    const plain = new ApiError("forbidden", 403, "no");
    expect(errorMessage(t, plain)).toBe(t("errors.forbidden"));
  });
});
