import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { type HelpTopic, type Snippet, snippetMatches } from "../registry";
import { SnippetCard } from "./Snippet";
import "../help.css";

/**
 * A compact, searchable help panel: snippets grouped by topic, each with "Insert" where the
 * screen takes it. `notes` says how the screen's own settings (time range, variables) apply,
 * `docs` links the guide section. `focus` names an entry to scroll to and mark, such as the one
 * an error hint points to.
 */
export function HelpPanel<V>({
  title,
  lead,
  topics,
  snippets,
  notes,
  docs,
  focus,
  onInsert,
  onClose,
  shortcut,
}: {
  title: string;
  lead?: string;
  topics: readonly HelpTopic[];
  snippets: readonly Snippet<V>[];
  notes?: ReactNode;
  docs?: { href: string; label: string } | undefined;
  focus?: string | undefined;
  onInsert?: ((value: V, snippet: Snippet<V>) => void) | undefined;
  onClose: () => void;
  /** The keys that open and close the panel, as shown to the reader. */
  shortcut?: string | undefined;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const shown = snippets.filter((snippet) => snippetMatches(t, snippet, search));

  useEffect(() => {
    if (focus === undefined) return;
    const entry = listRef.current?.querySelector<HTMLElement>(
      `[data-snippet="${CSS.escape(focus)}"]`,
    );
    entry?.scrollIntoView?.({ block: "nearest" });
  }, [focus]);

  const grouped = topics
    .map((topic) => ({ topic, entries: shown.filter((snippet) => snippet.topic === topic.id) }))
    .filter((group) => group.entries.length > 0);
  const loose = shown.filter((snippet) => !topics.some((topic) => topic.id === snippet.topic));

  return (
    <section className="help-panel" aria-labelledby={headingId}>
      <div className="help-panel__head">
        <h2 className="help-panel__title" id={headingId}>
          {title}
        </h2>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={onClose}
          aria-label={t("help.panel.closeTitle", { title })}
          title={shortcut === undefined ? undefined : t("help.panel.shortcut", { keys: shortcut })}
        >
          <Icon name="close" />
        </button>
      </div>
      {lead === undefined ? null : <p className="help-panel__lead">{lead}</p>}
      <div className="field">
        <label className="field__label" htmlFor={searchId}>
          {t("help.panel.search")}
        </label>
        <input
          id={searchId}
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
      <div className="help-panel__list" ref={listRef}>
        {shown.length === 0 ? (
          <p className="help-panel__empty" role="status">
            {t("help.panel.none", { search: search.trim() })}
          </p>
        ) : null}
        {grouped.map(({ topic, entries }) => (
          <section key={topic.id} className="help-panel__topic" aria-label={t(topic.title)}>
            <h3 className="help-panel__topic-title">{t(topic.title)}</h3>
            {entries.map((snippet) => (
              <SnippetCard
                key={snippet.id}
                snippet={snippet}
                highlighted={snippet.id === focus}
                onInsert={
                  onInsert === undefined ? undefined : (value: V) => onInsert(value, snippet)
                }
              />
            ))}
          </section>
        ))}
        {loose.map((snippet) => (
          <SnippetCard
            key={snippet.id}
            snippet={snippet}
            highlighted={snippet.id === focus}
            onInsert={onInsert === undefined ? undefined : (value: V) => onInsert(value, snippet)}
          />
        ))}
      </div>
      {notes === undefined ? null : <div className="help-panel__notes">{notes}</div>}
      {docs === undefined ? null : (
        <a className="help-panel__docs" href={docs.href} target="_blank" rel="noopener noreferrer">
          {docs.label}
          <Icon name="external" />
        </a>
      )}
    </section>
  );
}
