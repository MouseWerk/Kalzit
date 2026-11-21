/**
 * The Markdown of the guide as a tree, for the handbook (src/handbook/Article.tsx draws it as React
 * elements, never as HTML strings) and for the build, which takes titles, headings, pictures and
 * the search index from the same tree (src/handbook/build/plugin.ts). No imports: the build runs
 * it in Node.
 *
 * It knows what the guide uses: headings, paragraphs, emphasis, inline code, fenced code (also
 * inside list items), ordered and unordered lists with nested blocks, quotes and GitHub's callouts
 * (`> [!NOTE]`), tables, rules, pictures (Markdown and the `<picture>` lines of the guide) and
 * links. Any other HTML stays the text it is.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] }
  | { type: "image"; src: string; alt: string };

export type CalloutKind = "note" | "tip" | "important" | "warning" | "caution";

export type Block =
  | { type: "heading"; level: number; id: string; content: Inline[] }
  | { type: "paragraph"; content: Inline[] }
  | { type: "code"; language: string; text: string }
  | { type: "list"; ordered: boolean; start: number; items: Block[][] }
  | { type: "quote"; callout: CalloutKind | null; children: Block[] }
  | { type: "table"; head: Inline[][]; rows: Inline[][][] }
  | { type: "image"; src: string; alt: string }
  | { type: "rule" };

// Every part has an upper length, so a long run of "[", "*" or "`" without a closing mark costs a
// bounded scan per position: parsing stays linear (as in src/panels/text/markdown.tsx).
const INLINE =
  /(`{1,10})([\s\S]{0,2000}?)\1|\*\*([^*]{1,500})\*\*|__([^_]{1,500})__|\*([^*\s][^*]{0,499})\*|(?<![\w])_([^_\s][^_]{0,499})_(?![\w])|(!?)\[((?:[^\]]|\][^(]){0,500}?)\]\(((?:[^()\s]|\([^()\s]{0,200}\)){1,2000})(?:\s+"[^"]{0,200}")?\)|<(https?:\/\/[^>\s]{1,2000})>/;

/** Inline Markdown: code, strong, emphasis, links and pictures; the rest is text. */
export function parseInline(text: string): Inline[] {
  const nodes: Inline[] = [];
  let rest = text;
  const pushText = (part: string) => {
    if (part === "") return;
    const last = nodes[nodes.length - 1];
    if (last?.type === "text") {
      last.text += part;
    } else {
      nodes.push({ type: "text", text: part });
    }
  };
  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (match === null) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, match.index));
    const [whole, , code, strong1, strong2, em1, em2, bang, label, href, auto] = match;
    if (code !== undefined) {
      // Like CommonMark: one space on both sides of a code span is padding.
      const inner = /^ .* $/.test(code) && code.trim() !== "" ? code.slice(1, -1) : code;
      nodes.push({ type: "code", text: inner });
    } else if (strong1 !== undefined || strong2 !== undefined) {
      nodes.push({ type: "strong", children: parseInline(strong1 ?? strong2 ?? "") });
    } else if (em1 !== undefined || em2 !== undefined) {
      nodes.push({ type: "em", children: parseInline(em1 ?? em2 ?? "") });
    } else if (label !== undefined && href !== undefined) {
      if (bang === "!") {
        nodes.push({ type: "image", src: href, alt: label });
      } else {
        nodes.push({ type: "link", href, children: parseInline(label) });
      }
    } else if (auto !== undefined) {
      nodes.push({ type: "link", href: auto, children: [{ type: "text", text: auto }] });
    }
    rest = rest.slice(match.index + whole.length);
  }
  return nodes;
}

/** The text of inline nodes, without marks; pictures count with their alternative text. */
export function plainText(nodes: readonly Inline[]): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "image":
          return node.alt;
        default:
          return plainText(node.children);
      }
    })
    .join("");
}

/**
 * The anchor of a heading as GitHub makes it, so links between guide pages keep working: lower
 * case, letters (umlauts included), digits, spaces, "-" and "_" kept, spaces become "-".
 */
export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

/** Gives repeated anchors the suffixes GitHub gives them ("-1", "-2"). */
export function createSlugger(): (text: string) => string {
  const seen = new Map<string, number>();
  return (text) => {
    const base = slugify(text);
    const count = seen.get(base);
    seen.set(base, (count ?? 0) + 1);
    return count === undefined ? base : `${base}-${count}`;
  };
}

const FENCE = /^(\s*)(`{3,}|~{3,})\s*([\w+#.-]*)/;
const BULLET = /^(\s*)([-*+]|\d{1,9}[.)])(\s+|$)/;
const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const CALLOUT = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*$/i;
const PICTURE = /^\s*<picture>.*<img\b[^>]*>.*<\/picture>\s*$/i;
const IMAGE_LINE = /^\s*!\[[^\]]*\]\([^)]*\)\s*$/;

function cellsOf(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  // A "|" inside inline code or escaped as "\|" stays part of its cell.
  const cells: string[] = [];
  let cell = "";
  let code = false;
  for (let i = 0; i < trimmed.length; i++) {
    const char = trimmed[i] as string;
    if (char === "\\" && trimmed[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (char === "`") {
      code = !code;
      cell += char;
    } else if (char === "|" && !code) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += char;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function attribute(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`, "i").exec(tag)?.[1];
}

function indentOf(line: string): number {
  return /^\s*/.exec(line.replace(/\t/g, "    "))?.[0].length ?? 0;
}

/** Whether a line starts a block other than a paragraph, so it ends the paragraph before it. */
function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    /^\s*>/.test(line) ||
    BULLET.test(line) ||
    RULE.test(line) ||
    PICTURE.test(line)
  );
}

/** Parses a document (or the inside of a list item or quote) into blocks. */
export function parseBlocks(source: string, slug: (text: string) => string = createSlugger()) {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  return blocksOf(lines, slug);
}

function blocksOf(lines: readonly string[], slug: (text: string) => string): Block[] {
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const indent = (fence[1] as string).length;
      const mark = fence[2] as string;
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(mark)) {
        const text = lines[i] as string;
        // The fence's own indent is not part of the code.
        body.push(text.slice(Math.min(indent, indentOf(text))));
        i++;
      }
      i++;
      blocks.push({ type: "code", language: fence[3] ?? "", text: body.join("\n") });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      const content = parseInline(heading[2] as string);
      blocks.push({
        type: "heading",
        level: (heading[1] as string).length,
        id: slug(plainText(content)),
        content,
      });
      i++;
      continue;
    }
    if (RULE.test(line) && !BULLET.test(line)) {
      blocks.push({ type: "rule" });
      i++;
      continue;
    }
    if (PICTURE.test(line)) {
      const img = /<img\b[^>]*>/i.exec(line)?.[0] ?? "";
      blocks.push({
        type: "image",
        src: attribute(img, "src") ?? "",
        alt: attribute(img, "alt") ?? "",
      });
      i++;
      continue;
    }
    if (IMAGE_LINE.test(line)) {
      const [node] = parseInline(line.trim());
      if (node?.type === "image") {
        blocks.push({ type: "image", src: node.src, alt: node.alt });
        i++;
        continue;
      }
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      const marker = CALLOUT.exec(quoted[0]?.trim() ?? "");
      const callout = marker === null ? null : ((marker[1] as string).toLowerCase() as CalloutKind);
      blocks.push({
        type: "quote",
        callout,
        children: blocksOf(callout === null ? quoted : quoted.slice(1), slug),
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet !== null) {
      const listIndent = indentOf(line);
      const ordered = /\d/.test(bullet[2] as string);
      const start = ordered ? Number.parseInt(bullet[2] as string, 10) : 1;
      const items: Block[][] = [];
      while (i < lines.length) {
        const first = lines[i] as string;
        const marker = BULLET.exec(first);
        if (
          marker === null ||
          indentOf(first) !== listIndent ||
          /\d/.test(marker[2] as string) !== ordered
        ) {
          break;
        }
        // The item's content starts after the marker; its own lines are indented that far.
        const contentIndent = (marker[0] as string).length;
        const body = [first.slice(contentIndent)];
        i++;
        while (i < lines.length) {
          const next = lines[i] as string;
          if (next.trim() === "") {
            // A blank line belongs to the item when the item goes on after it.
            const after = lines.slice(i + 1).find((rest) => rest.trim() !== "");
            if (after !== undefined && indentOf(after) >= contentIndent) {
              body.push("");
              i++;
              continue;
            }
            break;
          }
          if (indentOf(next) >= contentIndent) {
            body.push(next.slice(contentIndent));
            i++;
            continue;
          }
          // A lazy continuation of the item's paragraph: a plain line right after text.
          const previous = body[body.length - 1] ?? "";
          if (previous.trim() !== "" && !startsBlock(next) && !FENCE.test(previous)) {
            body.push(next.trim());
            i++;
            continue;
          }
          break;
        }
        items.push(blocksOf(body, slug));
        // Blank lines between items keep one list.
        let j = i;
        while (j < lines.length && (lines[j] as string).trim() === "") j++;
        const following = lines[j];
        if (j > i && following !== undefined && BULLET.test(following)) {
          if (indentOf(following) === listIndent) i = j;
        }
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1] as string)) {
      const head = cellsOf(line).map(parseInline);
      const rows: Inline[][][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|")) {
        rows.push(cellsOf(lines[i] as string).map(parseInline));
        i++;
      }
      blocks.push({ type: "table", head, rows });
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length) {
      const next = lines[i] as string;
      if (next.trim() === "" || (paragraph.length > 0 && startsBlock(next))) break;
      // A hard line break ("\" or two spaces at the end) is kept as a space.
      paragraph.push(next.trim().replace(/\\$/, ""));
      i++;
    }
    blocks.push({ type: "paragraph", content: parseInline(paragraph.join(" ")) });
  }
  return blocks;
}

/** A heading of a page, for "On this page" and to match sections across languages. */
export interface HeadingInfo {
  id: string;
  level: number;
  text: string;
}

/** Every heading of a document in order, nested ones (in quotes and lists) included. */
export function headingsOf(blocks: readonly Block[]): HeadingInfo[] {
  const out: HeadingInfo[] = [];
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      if (block.type === "heading") {
        out.push({ id: block.id, level: block.level, text: plainText(block.content) });
      } else if (block.type === "quote") {
        walk(block.children);
      } else if (block.type === "list") {
        for (const item of block.items) walk(item);
      }
    }
  };
  walk(blocks);
  return out;
}

/** The text of blocks for the search index: words only, code included, pictures by their name. */
export function blockText(blocks: readonly Block[]): string {
  return blocks
    .map((block) => {
      switch (block.type) {
        case "heading":
        case "paragraph":
          return plainText(block.content);
        case "code":
          return block.text;
        case "list":
          return block.items.map(blockText).join(" ");
        case "quote":
          return blockText(block.children);
        case "table":
          return [block.head, ...block.rows].map((row) => row.map(plainText).join(" ")).join(" ");
        case "image":
          return block.alt;
        default:
          return "";
      }
    })
    .filter((text) => text !== "")
    .join("\n");
}

/** A part of a page for the search: the text from one heading to the next. */
export interface Section {
  /** The heading's anchor; empty for the text before the first section heading. */
  id: string;
  heading: string;
  text: string;
}

/** A page cut into sections at its headings of level 2 and 3; the title starts the first one. */
export function sectionsOf(blocks: readonly Block[]): Section[] {
  const sections: Section[] = [];
  let current: { id: string; heading: string; blocks: Block[] } = {
    id: "",
    heading: "",
    blocks: [],
  };
  const flush = () => {
    const text = blockText(current.blocks).replace(/\s+/g, " ").trim();
    if (text !== "" || current.id !== "") {
      sections.push({ id: current.id, heading: current.heading, text });
    }
  };
  for (const block of blocks) {
    if (block.type === "heading" && block.level >= 2) {
      flush();
      current = { id: block.id, heading: plainText(block.content), blocks: [] };
    } else if (block.type !== "heading") {
      current.blocks.push(block);
    }
  }
  flush();
  return sections;
}

/** The page's title: its first heading of level 1. */
export function titleOf(blocks: readonly Block[]): string | undefined {
  const heading = blocks.find((block) => block.type === "heading" && block.level === 1);
  return heading?.type === "heading" ? plainText(heading.content) : undefined;
}

/** The pictures of a document, in order: Markdown pictures and `<picture>` lines alike. */
export function imagesOf(blocks: readonly Block[]): string[] {
  const out: string[] = [];
  const inline = (nodes: readonly Inline[]) => {
    for (const node of nodes) {
      if (node.type === "image") out.push(node.src);
      else if (node.type === "strong" || node.type === "em" || node.type === "link") {
        inline(node.children);
      }
    }
  };
  const walk = (list: readonly Block[]) => {
    for (const block of list) {
      switch (block.type) {
        case "image":
          out.push(block.src);
          break;
        case "heading":
        case "paragraph":
          inline(block.content);
          break;
        case "list":
          for (const item of block.items) walk(item);
          break;
        case "quote":
          walk(block.children);
          break;
        case "table":
          for (const row of [block.head, ...block.rows]) for (const cell of row) inline(cell);
          break;
        default:
          break;
      }
    }
  };
  walk(blocks);
  return out;
}

/**
 * The language line on top of each guide page ("English | [Deutsch](de/x.md)"): the handbook has
 * its own way to switch, so the line is left out.
 */
export const LANGUAGE_LINE =
  /^(English \| \[Deutsch\]\([^)]*\)|\[English\]\([^)]*\) \| Deutsch)\s*$/m;

/** The page's source without the language line. */
export function withoutLanguageLine(source: string): string {
  return source.replace(LANGUAGE_LINE, "");
}

/**
 * Resolves a relative link of a file below docs/ ("guide/de/x.md") to a path in the repository
 * ("docs/guide/x.md", "README.md"); null when it leads above the repository.
 */
export function resolveRepoPath(from: string, target: string): string | null {
  const parts = `docs/${from}`.split("/").slice(0, -1);
  for (const part of target.split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(part);
    }
  }
  return parts.join("/");
}
