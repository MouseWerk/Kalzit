import { type ReactNode, useId } from "react";
import { useI18n } from "../../i18n/i18n";
import { helpText, type Snippet } from "../registry";
import "../help.css";

/** The code behind an action, folded away: people see the language and learn it as they go. */
export function ShowQuery({ code, label }: { code: string; label?: string }) {
  const { t } = useI18n();
  return (
    <details className="help-query">
      <summary>{label ?? t("help.showQuery")}</summary>
      <pre className="help-code">
        <code>{code}</code>
      </pre>
    </details>
  );
}

/**
 * One snippet of a help panel: what it does, its code, and "Insert" when the screen can take it.
 * `highlighted` marks the entry an error hint pointed to, with a neutral tint.
 */
export function SnippetCard<V>({
  snippet,
  onInsert,
  highlighted = false,
  extra,
}: {
  snippet: Snippet<V>;
  onInsert?: ((value: V) => void) | undefined;
  highlighted?: boolean;
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const title = helpText(t, snippet.title);
  const { value } = snippet;
  return (
    <article
      className="help-snippet"
      aria-labelledby={titleId}
      data-snippet={snippet.id}
      data-highlighted={highlighted ? "true" : undefined}
    >
      <h4 className="help-snippet__title" id={titleId}>
        {title}
      </h4>
      {snippet.text === undefined ? null : (
        <p className="help-snippet__text">{helpText(t, snippet.text)}</p>
      )}
      <pre className="help-code">
        <code>{snippet.code}</code>
      </pre>
      {extra}
      {value === undefined || onInsert === undefined ? null : (
        <div className="help-snippet__actions">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onInsert(value)}
            aria-label={t("help.insertNamed", { title })}
          >
            {t("help.insert")}
          </button>
        </div>
      )}
    </article>
  );
}
