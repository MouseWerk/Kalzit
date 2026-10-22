import type { ReactNode } from "react";
import "../viz.css";

/**
 * A small Markdown renderer that builds React elements and never HTML strings, so nothing a
 * panel's text contains can become markup or script: raw HTML shows as the text it is. It knows
 * headings, paragraphs, emphasis, inline code, code blocks, lists, quotes, rules, tables and
 * links. Links are kept only for web, mail and same-site addresses.
 */

const SAFE_HREF = /^(https?:\/\/|mailto:|\/(?!\/)|#|\.\/|\?)/i;

export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  return SAFE_HREF.test(trimmed) ? trimmed : null;
}

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

const INLINE =
  /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\s][^*]*)\*|_([^_\s][^_]*)_|\[([^\]]+)\]\(([^)\s]+)\)/;

/** Inline Markdown: code, strong, emphasis and links; the rest is text. */
export function inline(text: string, key = "i"): ReactNode[] {
  const nodes: ReactNode[] = [];
  let rest = text;
  let n = 0;
  while (rest !== "") {
    const match = INLINE.exec(rest);
    if (match === null) {
      nodes.push(rest);
      break;
    }
    if (match.index > 0) {
      nodes.push(rest.slice(0, match.index));
    }
    const id = `${key}-${n++}`;
    const [whole, , code, strong1, strong2, em1, em2, label, href] = match;
    if (code !== undefined) {
      nodes.push(<code key={id}>{code}</code>);
    } else if (strong1 !== undefined || strong2 !== undefined) {
      nodes.push(<strong key={id}>{inline(strong1 ?? strong2 ?? "", id)}</strong>);
    } else if (em1 !== undefined || em2 !== undefined) {
      nodes.push(<em key={id}>{inline(em1 ?? em2 ?? "", id)}</em>);
    } else if (label !== undefined && href !== undefined) {
      const safe = safeHref(href);
      nodes.push(
        safe === null ? (
          label
        ) : (
          <a key={id} href={safe} rel="noopener noreferrer">
            {inline(label, id)}
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

/** Block Markdown to React elements. */
export function markdown(source: string): ReactNode[] {
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
          <code>{body.join("\n")}</code>
        </pre>,
      );
      continue;
    }
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading !== null) {
      // Panel text sits below the panel's own title, so its headings start one level lower.
      const level = Math.min(6, (heading[1] as string).length + 2);
      const Tag = `h${level}` as "h3";
      blocks.push(<Tag key={key()}>{inline(heading[2] as string)}</Tag>);
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
      blocks.push(<blockquote key={key()}>{markdown(quoted.join("\n"))}</blockquote>);
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
        <li key={n}>{inline(entry, `l${n}`)}</li>
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
                    {inline(cell, `h${n}`)}
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
                    <td key={c}>{inline(row[c] ?? "", `c${r}-${c}`)}</td>
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
    blocks.push(<p key={key()}>{inline(paragraph.join(" "))}</p>);
  }
  return blocks;
}
