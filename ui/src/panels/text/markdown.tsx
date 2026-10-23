import type { ReactNode } from "react";
import { isSafeHref } from "../fieldConfig/fieldConfig";
import "../viz.css";

/**
 * A small Markdown renderer that builds React elements and never HTML strings, so nothing a
 * panel's text contains can become markup or script: raw HTML shows as the text it is. It knows
 * headings, paragraphs, emphasis, inline code, code blocks, lists, quotes, rules, tables and
 * links. Links are kept only for web, mail and same-site addresses.
 */

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return isSafeHref(trimmed) ? trimmed : null;
}

type Variables = Readonly<Record<string, string>>;
const NONE: Variables = {};

/** `$name`, `${name}` and `[[name]]` replaced by the variable's value; unknown names stay. */
export function interpolate(text: string, variables: Readonly<Record<string, string>>): string {
  return text.replace(
    /\$\{(\w+)\}|\[\[(\w+)\]\]|\$(\w+)/g,
    (
      match,
      braced: string | undefined,
      bracketed: string | undefined,
      plain: string | undefined,
    ) => {
      const name = braced ?? bracketed ?? plain ?? "";
      return Object.hasOwn(variables, name) ? (variables[name] as string) : match;
    },
  );
}

// Every part has an upper length, so a long run of "[", "*" or "`" without a closing mark costs
// a bounded scan per position instead of one to the end of the text: parsing stays linear.
const INLINE =
  /(`{1,10})([\s\S]{0,2000}?)\1|\*\*([^*]{1,500})\*\*|__([^_]{1,500})__|\*([^*\s][^*]{0,499})\*|_([^_\s][^_]{0,499})_|\[([^\]]{1,500})\]\(((?:[^()\s]|\([^()\s]{0,200}\)){1,2000})\)/;

/** Inline Markdown: code, strong, emphasis and links; the rest is text. */
export function inline(text: string, key = "i", variables: Variables = NONE): ReactNode[] {
  const fill = (part: string) => interpolate(part, variables);
  const nodes: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (match === null) {
      nodes.push(fill(rest));
      break;
    }
    if (match.index > 0) {
      nodes.push(fill(rest.slice(0, match.index)));
    }
    const id = `${key}-${n++}`;
    const [whole, , code, strong1, strong2, em1, em2, label, href] = match;
    if (code !== undefined) {
      nodes.push(<code key={id}>{fill(code)}</code>);
    } else if (strong1 !== undefined || strong2 !== undefined) {
      nodes.push(<strong key={id}>{inline(strong1 ?? strong2 ?? "", id, variables)}</strong>);
    } else if (em1 !== undefined || em2 !== undefined) {
      nodes.push(<em key={id}>{inline(em1 ?? em2 ?? "", id, variables)}</em>);
    } else if (label !== undefined && href !== undefined) {
      const safe = safeHref(href);
      nodes.push(
        safe === null ? (
          fill(label)
        ) : (
          <a key={id} href={safe} rel="noopener noreferrer">
            {inline(label, id, variables)}
          </a>
        ),
      );
    }
    rest = rest.slice(match.index + whole.length);
  }
  return nodes;
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

/**
 * Block Markdown to React elements. Variables are filled in after parsing and only into text,
 * so a value can never add a link, emphasis or anything else.
 */
export function markdown(source: string, variables: Variables = NONE): ReactNode[] {
  const text = (part: string, key?: string) => inline(part, key, variables);
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;
  let k = 0;
  const key = () => `b${k++}`;
  while (i < lines.length) {
    const line = lines[i] as string;
    if (line.trim() === "") {
      i++;
      continue;
    }
    const fence = /^\s*(```|~~~)/.exec(line);
    if (fence !== null) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] as string).trim().startsWith(fence[1] as string)) {
        body.push(lines[i] as string);
        i++;
      }
      i++;
      blocks.push(
        <pre key={key()}>
          <code>{interpolate(body.join("\n"), variables)}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      // Panel text sits below the panel's own title, so its headings start one level lower.
      const level = Math.min(6, (heading[1] as string).length + 2);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key()}>{text(heading[2] as string)}</Tag>);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      blocks.push(<hr key={key()} />);
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i] as string)) {
        quoted.push((lines[i] as string).replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push(<blockquote key={key()}>{markdown(quoted.join("\n"), variables)}</blockquote>);
      continue;
    }
    const bullet = /^\s*([-*+]|\d+[.)])\s+/;
    if (bullet.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const entries: string[] = [];
      while (i < lines.length && bullet.test(lines[i] as string)) {
        entries.push((lines[i] as string).replace(bullet, ""));
        i++;
      }
      const children = entries.map((entry, n) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: list entries keep their order
        <li key={n}>{text(entry, `l${n}`)}</li>
      ));
      blocks.push(ordered ? <ol key={key()}>{children}</ol> : <ul key={key()}>{children}</ul>);
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && TABLE_RULE.test(lines[i + 1] as string)) {
      const head = cellsOf(line);
      const body: string[][] = [];
      i += 2;
      while (i < lines.length && (lines[i] as string).includes("|")) {
        body.push(cellsOf(lines[i] as string));
        i++;
      }
      blocks.push(
        <div key={key()} className="text-panel__table">
          <table>
            <thead>
              <tr>
                {head.map((cell, n) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: columns keep their order
                  <th key={n} scope="col">
                    {text(cell, `h${n}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {body.map((row, r) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
                <tr key={r}>
                  {head.map((_, c) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns keep their order
                    <td key={c}>{text(row[c] ?? "", `c${r}-${c}`)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (
      i < lines.length &&
      (lines[i] as string).trim() !== "" &&
      !/^\s*(#{1,6}\s|```|~~~|>|[-*+]\s|\d+[.)]\s)/.test(lines[i] as string)
    ) {
      paragraph.push((lines[i] as string).trim());
      i++;
    }
    if (paragraph.length === 0) {
      // A line no block takes (such as a lone "|"): shown as text so nothing is lost.
      paragraph.push(line.trim());
      i++;
    }
    blocks.push(<p key={key()}>{text(paragraph.join(" "))}</p>);
  }
  return blocks;
}
