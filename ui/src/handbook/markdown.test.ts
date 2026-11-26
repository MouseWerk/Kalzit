import { describe, expect, it } from "vitest";
import {
  type Block,
  createSlugger,
  headingsOf,
  imagesOf,
  parseBlocks,
  parseInline,
  resolveRepoPath,
  sectionsOf,
  slugify,
  withoutLanguageLine,
} from "./markdown";
import { normalizeWord, prepare, search, snippetOf, stem } from "./search";

describe("the handbook's Markdown", () => {
  it("makes anchors as GitHub does, umlauts kept and repeats numbered", () => {
    expect(slugify("Eine Abfrage ausführen")).toBe("eine-abfrage-ausführen");
    expect(slugify("`kalzit db copy`: SQLite to PostgreSQL")).toBe(
      "kalzit-db-copy-sqlite-to-postgresql",
    );
    const slug = createSlugger();
    expect([slug("API"), slug("API"), slug("API")]).toEqual(["api", "api-1", "api-2"]);
  });

  it("reads GitHub's callouts and keeps a plain quote as an example", () => {
    const [note, example] = parseBlocks("> [!WARNING]\n> Keep the key.\n\n> A plain quote.");
    expect(note).toMatchObject({ type: "quote", callout: "warning" });
    expect(example).toMatchObject({ type: "quote", callout: null });
  });

  it("keeps code, lists and paragraphs inside a list item", () => {
    const source = [
      "1. Stop the server:",
      "",
      "   ```sh",
      "   sudo systemctl stop kalzit",
      "   ```",
      "",
      "   - **Copy, do not move.** A copied file",
      "     keeps its rights.",
      "   - Second",
      "2. Start it again.",
    ].join("\n");
    const [list] = parseBlocks(source);
    expect(list).toMatchObject({ type: "list", ordered: true });
    const items = (list as Extract<Block, { type: "list" }>).items;
    expect(items).toHaveLength(2);
    expect(items[0]?.map((block) => block.type)).toEqual(["paragraph", "code", "list"]);
    expect(items[0]?.[1]).toEqual({
      type: "code",
      language: "sh",
      text: "sudo systemctl stop kalzit",
    });
    const nested = items[0]?.[2] as Extract<Block, { type: "list" }>;
    expect(nested.items).toHaveLength(2);
  });

  it("splits table cells, but not at a bar inside code", () => {
    const [table] = parseBlocks("| Key | Means |\n|---|---|\n| `a|b` | either |");
    expect(table).toMatchObject({ type: "table" });
    const rows = (table as Extract<Block, { type: "table" }>).rows;
    expect(rows[0]).toHaveLength(2);
    expect(rows[0]?.[0]).toEqual([{ type: "code", text: "a|b" }]);
  });

  it("shows the picture of a <picture> line and lists every picture", () => {
    const blocks = parseBlocks(
      '<picture><source srcset="../screenshots/a-light.webp"><img src="../screenshots/a-dark.webp" alt="Settings, AI"></picture>\n\n![Explore](../screenshots/explore.png)',
    );
    expect(blocks[0]).toEqual({
      type: "image",
      src: "../screenshots/a-dark.webp",
      alt: "Settings, AI",
    });
    expect(imagesOf(blocks)).toEqual(["../screenshots/a-dark.webp", "../screenshots/explore.png"]);
  });

  it("reads links, pictures, code and emphasis inline, other HTML as text", () => {
    expect(
      parseInline("See [Backups](app:/settings/backups) or <https://kalzit.dev>, `x` <b>"),
    ).toEqual([
      { type: "text", text: "See " },
      {
        type: "link",
        href: "app:/settings/backups",
        children: [{ type: "text", text: "Backups" }],
      },
      { type: "text", text: " or " },
      {
        type: "link",
        href: "https://kalzit.dev",
        children: [{ type: "text", text: "https://kalzit.dev" }],
      },
      { type: "text", text: ", " },
      { type: "code", text: "x" },
      { type: "text", text: " <b>" },
    ]);
    // A word with underscores is no emphasis.
    expect(parseInline("backups.keep_count and snake_case_name")).toEqual([
      { type: "text", text: "backups.keep_count and snake_case_name" },
    ]);
  });

  it("drops the language line and cuts a page into sections at its headings", () => {
    const source = withoutLanguageLine(
      "English | [Deutsch](de/x.md)\n\n# Title\n\nLead.\n\n## First\n\nOne.\n\n### Inner\n\nTwo.",
    );
    expect(source).not.toContain("Deutsch");
    const blocks = parseBlocks(source);
    expect(headingsOf(blocks).map((heading) => heading.id)).toEqual(["title", "first", "inner"]);
    expect(sectionsOf(blocks)).toEqual([
      { id: "", heading: "", text: "Lead." },
      { id: "first", heading: "First", text: "One." },
      { id: "inner", heading: "Inner", text: "Two." },
    ]);
  });

  it("resolves a guide file's links to paths of the repository", () => {
    expect(resolveRepoPath("guide/de/explore.md", "../../api/datasources.md")).toBe(
      "docs/api/datasources.md",
    );
    expect(resolveRepoPath("guide/explore.md", "../screenshots/explore.png")).toBe(
      "docs/screenshots/explore.png",
    );
    expect(resolveRepoPath("guide/README.md", "../../README.md")).toBe("README.md");
    expect(resolveRepoPath("guide/README.md", "../../../x")).toBeNull();
  });
});

describe("the handbook's search", () => {
  const index = prepare({
    language: "de",
    entries: [
      {
        p: "query-languages",
        a: "neo4j-und-memgraph",
        t: "Abfragesprachen für Einsteiger",
        h: "Neo4j und Memgraph",
        x: "Die kürzeste Kette von Bekanntschaften zwischen zwei Personen, höchstens vier Schritte. Verwende dafür das Panel Pfade.",
      },
      {
        p: "panels",
        a: "pfade",
        t: "Panels",
        h: "Pfade",
        x: "Zeigt den kürzesten Pfad zwischen zwei Knoten.",
      },
      { p: "explore", a: "", t: "Explore", h: "", x: "Explore führt freie Abfragen aus." },
    ],
  });

  it("finds word forms and umlauts written out, every word of the query", () => {
    expect(normalizeWord("Kürzester")).toBe("kuerzester");
    expect(stem("kuerzester")).toBe("kuerzest");
    const hits = search(index, "kuerzester pfad");
    expect(hits.map((hit) => hit.entry.p)).toEqual(["panels", "query-languages"]);
    expect(search(index, "kürzeste kubernetes")).toEqual([]);
  });

  it("ranks a heading above the text and shows the sentence of the word", () => {
    const [first] = search(index, "pfade");
    expect(first?.entry.p).toBe("panels");
    const snippet = snippetOf("Erster Satz. Die kürzeste Kette, dann mehr. Rest.", ["kuerzest"]);
    expect(snippet).toEqual({ before: "Die ", match: "kürzeste", after: " Kette, dann mehr." });
  });
});
