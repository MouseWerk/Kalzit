import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, type Ref, useEffect, useState } from "react";
import { Icon, type IconName } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { withBase } from "../lib/basePath";
import { writeClipboard } from "../lib/clipboard";
import { showToast } from "../lib/toasts";
import { useCurrentOrg, useOrgPermissions } from "../org/useOrg";
import { appLinkAccess } from "./appLinks";
import { imageUrl, resolveLink } from "./content";
import type { Block, CalloutKind, Inline } from "./markdown";
import { plainText } from "./markdown";
import "./handbook.css";

/**
 * A handbook page drawn from its Markdown tree (src/handbook/markdown.ts) as React elements, never
 * as an HTML string: nothing in a file can become markup or script. Frame 3 of the board:
 * headings with a link to their section, code blocks with their language and Copy, tables that
 * scroll in their own frame, callouts, pictures from the bundle, and links that stay in the
 * handbook, open a screen of the app or lead to GitHub in a new tab.
 */

interface Context {
  /** The file the page comes from, below docs/; its relative links resolve against it. */
  file: string;
  /** The page's slug, for links to a section of the same page. */
  slug: string;
}

const CALLOUT_ICONS: Record<CalloutKind | "example", IconName> = {
  note: "info",
  tip: "sparkle",
  important: "info",
  warning: "alert",
  caution: "alert",
  example: "text",
};

// The names of the code blocks' languages as their header shows them.
const LANGUAGES: Record<string, string> = {
  sh: "Shell",
  bash: "Shell",
  shell: "Shell",
  console: "Shell",
  powershell: "PowerShell",
  ps1: "PowerShell",
  sql: "SQL",
  js: "JavaScript",
  javascript: "JavaScript",
  ts: "TypeScript",
  typescript: "TypeScript",
  json: "JSON",
  jsonc: "JSON",
  toml: "TOML",
  yaml: "YAML",
  yml: "YAML",
  go: "Go",
  cypher: "Cypher",
  gsql: "GSQL",
  promql: "PromQL",
  logql: "LogQL",
  nginx: "nginx",
  caddy: "Caddyfile",
  ini: "INI",
  xml: "XML",
  http: "HTTP",
  text: "",
  txt: "",
};

export function languageName(language: string): string {
  const known = LANGUAGES[language.toLowerCase()];
  return known ?? language;
}

function AppLink({ path, children }: { path: string; children: ReactNode }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const org = useCurrentOrg();
  const navigate = useNavigate();
  const access = appLinkAccess(path, permissions, org?.id);
  if (!access.allowed) {
    return (
      <span className="hb-app hb-app--closed">
        <strong>{children}</strong>
        <span className="hb-app__note"> ({t("handbook.app.noAccess")})</span>
      </span>
    );
  }
  return (
    <a
      className="hb-app button button--secondary button--small"
      href={withBase(path)}
      onClick={(event) => {
        if (
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        ) {
          return;
        }
        event.preventDefault();
        void navigate({ href: path });
      }}
    >
      <Icon name={access.icon} />
      <AppLabel>{children}</AppLabel>
    </a>
  );
}

/** "Open Administration > Backups": the place in the sentence of the language. */
function AppLabel({ children }: { children: ReactNode }) {
  const { t } = useI18n();
  const marker = "\u0000";
  const [before = "", after = ""] = t("handbook.app.open", { place: marker }).split(marker);
  return (
    <span>
      {before}
      {children}
      {after}
    </span>
  );
}

function InlineNodes({ nodes, context }: { nodes: readonly Inline[]; context: Context }) {
  return nodes.map((node, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: inline parts keep their order
    <InlineNode key={index} node={node} context={context} />
  ));
}

function InlineNode({ node, context }: { node: Inline; context: Context }) {
  const { t } = useI18n();
  switch (node.type) {
    case "text":
      return node.text;
    case "code":
      return <code>{node.text}</code>;
    case "strong":
      return (
        <strong>
          <InlineNodes nodes={node.children} context={context} />
        </strong>
      );
    case "em":
      return (
        <em>
          <InlineNodes nodes={node.children} context={context} />
        </em>
      );
    case "image": {
      const src = imageUrl(context.file, node.src);
      return src === undefined ? (
        node.alt
      ) : (
        <img className="hb-inline-image" src={src} alt={node.alt} />
      );
    }
    case "link": {
      const label = <InlineNodes nodes={node.children} context={context} />;
      const target = resolveLink(context.file, node.href);
      if (target === null) return label;
      switch (target.kind) {
        case "page":
          return (
            <Link
              to="/handbook/$page"
              params={{ page: target.slug }}
              {...(target.anchor === "" ? {} : { hash: target.anchor })}
            >
              {label}
            </Link>
          );
        case "anchor":
          return (
            <Link to="/handbook/$page" params={{ page: context.slug }} hash={target.anchor}>
              {label}
            </Link>
          );
        case "app":
          return <AppLink path={target.path}>{label}</AppLink>;
        case "external": {
          const github = target.href.startsWith("https://github.com/");
          return (
            <a
              href={target.href}
              target="_blank"
              rel="noopener noreferrer"
              title={github ? t("handbook.opensGithub") : undefined}
              className="hb-external"
            >
              {label}
              <Icon name="external" />
            </a>
          );
        }
      }
    }
  }
}

function Heading({
  level,
  id,
  children,
  titleRef,
}: {
  level: number;
  id: string;
  children: ReactNode;
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const { t } = useI18n();
  if (level === 1) {
    return (
      <h1 className="hb-title" ref={titleRef} tabIndex={-1}>
        {children}
      </h1>
    );
  }
  // The guide's levels below the title: sections (h2), subsections (h3), deeper ones as h4.
  const Tag = level === 2 ? "h2" : level === 3 ? "h3" : "h4";
  const copy = async (event: React.MouseEvent<HTMLAnchorElement>) => {
    const url = new URL(event.currentTarget.href, window.location.href).href;
    if (await writeClipboard(url)) {
      showToast({ message: t("handbook.anchorCopied") });
    }
  };
  return (
    <Tag id={id} className="hb-heading" data-section="">
      {children}
      <a className="hb-heading__anchor" href={`#${encodeURIComponent(id)}`} onClick={copy}>
        <span aria-hidden="true">#</span>
        <span className="visually-hidden">{t("handbook.anchor")}</span>
      </a>
    </Tag>
  );
}

function CodeBlock({ language, text }: { language: string; text: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 2000);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const name = languageName(language);
  return (
    <figure
      className="hb-code"
      aria-label={name === "" ? t("handbook.codePlain") : t("handbook.code", { language: name })}
    >
      <div className="hb-code__head">
        <span className="hb-code__language">{name}</span>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={async () => setCopied(await writeClipboard(text))}
        >
          <Icon name={copied ? "check" : "copy"} />
          {copied ? t("handbook.copied") : t("handbook.copy")}
        </button>
      </div>
      {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a long line scrolls inside the block */}
      <pre className="hb-code__body" tabIndex={0}>
        <code>{text}</code>
      </pre>
    </figure>
  );
}

function Callout({ kind, children }: { kind: CalloutKind | "example"; children: ReactNode }) {
  const { t } = useI18n();
  const tone = kind === "warning" || kind === "caution" ? "warning" : "calm";
  return (
    // A note within the text, not a landmark of the page.
    <div
      role="note"
      className="hb-callout"
      data-tone={tone}
      aria-label={t(`handbook.callout.${kind}`)}
    >
      <p className="hb-callout__label">
        <Icon name={CALLOUT_ICONS[kind]} />
        {t(`handbook.callout.${kind}`)}
      </p>
      <div className="hb-callout__body">{children}</div>
    </div>
  );
}

function Figure({ src, alt, context }: { src: string; alt: string; context: Context }) {
  const { t } = useI18n();
  const url = imageUrl(context.file, src);
  if (url === undefined) {
    return <p className="hb-figure__missing">{alt}</p>;
  }
  return (
    <figure className="hb-figure">
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={t("handbook.image.open", { alt })}
      >
        <img src={url} alt={alt} loading="lazy" decoding="async" />
      </a>
    </figure>
  );
}

/** A list item: its text alone when it is one paragraph, else its blocks. */
function Item({ blocks, context }: { blocks: readonly Block[]; context: Context }) {
  const [first] = blocks;
  if (blocks.length === 1 && first?.type === "paragraph") {
    return <InlineNodes nodes={first.content} context={context} />;
  }
  return <Blocks blocks={blocks} context={context} />;
}

export function Blocks({
  blocks,
  context,
  titleRef,
}: {
  blocks: readonly Block[];
  context: Context;
  titleRef?: Ref<HTMLHeadingElement> | undefined;
}) {
  const { t } = useI18n();
  return blocks.map((block, index) => {
    const key = `${block.type}-${index}`;
    switch (block.type) {
      case "heading":
        return (
          <Heading key={key} level={block.level} id={block.id} titleRef={titleRef}>
            <InlineNodes nodes={block.content} context={context} />
          </Heading>
        );
      case "paragraph":
        return (
          <p key={key}>
            <InlineNodes nodes={block.content} context={context} />
          </p>
        );
      case "code":
        return <CodeBlock key={key} language={block.language} text={block.text} />;
      case "list": {
        const items = block.items.map((item, n) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: list items keep their order
          <li key={n}>
            <Item blocks={item} context={context} />
          </li>
        ));
        return block.ordered ? (
          <ol key={key} start={block.start === 1 ? undefined : block.start}>
            {items}
          </ol>
        ) : (
          <ul key={key}>{items}</ul>
        );
      }
      case "quote":
        return (
          <Callout key={key} kind={block.callout ?? "example"}>
            <Blocks blocks={block.children} context={context} />
          </Callout>
        );
      case "table":
        return (
          <section
            key={key}
            className="hb-table"
            aria-label={t("handbook.table", {
              columns: block.head.map((cell) => plainText(cell)).join(", "),
            })}
            // biome-ignore lint/a11y/noNoninteractiveTabindex: a wide table scrolls in its frame
            tabIndex={0}
          >
            <table>
              <thead>
                <tr>
                  {block.head.map((cell, n) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: columns keep their order
                    <th key={n} scope="col">
                      <InlineNodes nodes={cell} context={context} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, r) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows keep their order
                  <tr key={r}>
                    {block.head.map((_, c) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: columns keep their order
                      <td key={c}>
                        <InlineNodes nodes={row[c] ?? []} context={context} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      case "image":
        return <Figure key={key} src={block.src} alt={block.alt} context={context} />;
      case "rule":
        return <hr key={key} />;
      default:
        return null;
    }
  });
}
