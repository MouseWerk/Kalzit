import { describe, expect, it } from "vitest";
import { type Budget, check, chunkName, startFiles } from "../../scripts/bundle-budget.mjs";

const BUDGET: Budget = {
  start: 300,
  language: 200,
  languages: ["en", "de"],
  lazy: ["RangePopover"],
  chunk: 100,
  chunks: { "elk.bundled": 500 },
  total: 2000,
};

const HTML = `<!doctype html><html><head>
<link rel="stylesheet" href="/layers.css" />
<script src="/theme-boot.js"></script>
<script type="module" crossorigin src="/assets/index-Ckq_XnB8.js"></script>
<link rel="modulepreload" crossorigin href="/assets/i18n-DTlNwBN7.js">
<link rel="stylesheet" crossorigin href="/assets/index-BTBVj1NF.css">
<link rel="icon" href="/assets/favicon-AAAAAAAA.svg">
</head></html>`;

function sizes(entries: Record<string, number>): Map<string, number> {
  return new Map(Object.entries(entries));
}

const FITS = {
  "assets/index-Ckq_XnB8.js": 150,
  "assets/i18n-DTlNwBN7.js": 10,
  "assets/index-BTBVj1NF.css": 40,
  "assets/en-CV4Xs72S.js": 180,
  "assets/de-e8CQFtV5.js": 190,
  "assets/RangePopover-CfJHiv4p.js": 20,
  "assets/elk.bundled-C16U6ZTx.js": 450,
};

describe("bundle budget", () => {
  it("names chunks without their hash", () => {
    expect(chunkName("assets/en-CV4Xs72S.js")).toBe("en");
    expect(chunkName("assets/elk-worker.min-r_yRvuMO.js")).toBe("elk-worker.min");
    expect(chunkName("assets/index-BTBVj1NF.css")).toBe("index");
  });

  it("counts the module script, preloads and stylesheets of index.html as the start", () => {
    expect(startFiles(HTML).sort()).toEqual([
      "assets/i18n-DTlNwBN7.js",
      "assets/index-BTBVj1NF.css",
      "assets/index-Ckq_XnB8.js",
    ]);
  });

  it("passes a bundle within every limit", () => {
    const result = check(BUDGET, sizes(FITS), startFiles(HTML));
    expect(result.problems).toEqual([]);
    expect(result.startSize).toBe(200);
  });

  it("fails a heavier start, a language or lazy chunk on start, and an oversized chunk", () => {
    const start = [...startFiles(HTML), "assets/de-e8CQFtV5.js", "assets/RangePopover-CfJHiv4p.js"];
    const result = check(
      BUDGET,
      sizes({ ...FITS, "assets/SigmaCanvas-ozaunABj.js": 101, "assets/en-CV4Xs72S.js": 201 }),
      start,
    );
    expect(result.problems).toEqual([
      expect.stringContaining("first page load"),
      expect.stringContaining("en is 0.2 kB"),
      expect.stringContaining("de is loaded on start"),
      expect.stringContaining("RangePopover is loaded on start"),
      expect.stringContaining("SigmaCanvas"),
    ]);
  });

  it("fails when a chunk it names is gone, so a renamed catalog cannot slip past", () => {
    const { "assets/de-e8CQFtV5.js": _, ...withoutGerman } = FITS;
    expect(check(BUDGET, sizes(withoutGerman), startFiles(HTML)).problems).toEqual([
      expect.stringContaining("no chunk de"),
    ]);
  });

  it("fails a start that names nothing or a file the bundle lacks", () => {
    expect(check(BUDGET, sizes(FITS), []).problems).toContainEqual(
      expect.stringContaining("loads no script or stylesheet"),
    );
    expect(
      check(BUDGET, sizes(FITS), [...startFiles(HTML), "assets/gone-AAAAAAAA.js"]).problems,
    ).toEqual([expect.stringContaining("gone-AAAAAAAA.js, which is not in the bundle")]);
  });
});
