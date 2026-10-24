import { Fragment, type ReactNode } from "react";

/**
 * Text an admin wrote for the sign-in page, with a few Markdown marks: paragraphs (a blank line),
 * line breaks, **strong**, *emphasis* and [links](https://...) to http, https and mailto. It is
 * built from React elements, never parsed as HTML, so nothing in the text can run or style the
 * page; anything else stays as it was typed.
 */

type Token = { kind: "text"; text: string } | { kind: "node"; node: ReactNode };

const LINK = /\[([^\]\n]{1,200})\]\(([^)\s]{1,2000})\)/;
const STRONG = /\*\*([^*\n]{1,500})\*\*/;
const EMPHASIS = /(?:^|(?<=[\s(]))\*([^*\n]{1,500})\*/;

/** The link target if it is safe to follow: http, https or mailto only. */
export function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw);
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

function splitBy(
  tokens: Token[],
  pattern: RegExp,
  prefix: string,
  make: (match: RegExpExecArray, key: string) => ReactNode,
): Token[] {
  const out: Token[] = [];
  let counter = 0;
  for (const token of tokens) {
    if (token.kind === "node") {
      out.push(token);
      continue;
    }
    let rest = token.text;
    for (let match = pattern.exec(rest); match !== null; match = pattern.exec(rest)) {
      if (match.index > 0) {
        out.push({ kind: "text", text: rest.slice(0, match.index) });
      }
      out.push({ kind: "node", node: make(match, `${prefix}${counter++}`) });
      rest = rest.slice(match.index + match[0].length);
    }
    if (rest !== "") {
      out.push({ kind: "text", text: rest });
    }
  }
  return out;
}

function inline(text: string): ReactNode[] {
  let tokens: Token[] = [{ kind: "text", text }];
  tokens = splitBy(tokens, LINK, "l", (match, key) => {
    const href = safeHref(match[2] ?? "");
    return href === null ? (
      match[0]
    ) : (
      <a key={key} href={href} rel="noopener noreferrer" target="_blank">
        {match[1]}
      </a>
    );
  });
  tokens = splitBy(tokens, STRONG, "s", (match, key) => <strong key={key}>{match[1]}</strong>);
  tokens = splitBy(tokens, EMPHASIS, "e", (match, key) => <em key={key}>{match[1]}</em>);
  return tokens.map((token, index) =>
    token.kind === "text" ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of one line never reorder
      <Fragment key={index}>{token.text}</Fragment>
    ) : (
      token.node
    ),
  );
}

export function LimitedMarkdown({ text, className }: { text: string; className?: string }) {
  const paragraphs = text
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "");
  return (
    <div className={className}>
      {paragraphs.map((paragraph, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: paragraphs of a fixed text
        <p key={index}>
          {paragraph.split("\n").map((line, lineIndex) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: lines of a fixed text
            <Fragment key={lineIndex}>
              {lineIndex === 0 ? null : <br />}
              {inline(line)}
            </Fragment>
          ))}
        </p>
      ))}
    </div>
  );
}
