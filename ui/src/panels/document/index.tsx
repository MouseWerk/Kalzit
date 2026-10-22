import { useId, useState } from "react";
import { isRecord } from "../../api/client";
import { typeLabel, valueSummary } from "../../documents/labels";
import { valueAt } from "../../documents/paths";
import { SetPicker } from "../../documents/shared";
import { entriesOf, isContainer, typeOf, unwrap } from "../../documents/values";
import { useI18n } from "../../i18n/i18n";
import { EmptyPanel } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";

export interface CardOptions {
  /** The field whose value titles the card (`name`); `_id` when empty. */
  titlePath: string;
}

/** Below this depth nested values are summarized, so a deep document stays a readable card. */
const MAX_DEPTH = 6;

function Value({ value, depth }: { value: unknown; depth: number }) {
  const { t, language } = useI18n();
  const entries = entriesOf(value);
  if (!isContainer(value) || depth >= MAX_DEPTH || entries.length === 0) {
    return (
      <span className="doc-card__value">
        <span>{valueSummary(t, value, language)}</span>
        <span className="doc-tree__type">{typeLabel(t, typeOf(value))}</span>
      </span>
    );
  }
  if (Array.isArray(value)) {
    return (
      <ol className="doc-card__list">
        {entries.map(([i, item]) => (
          <li key={i}>
            <Value value={item} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  return <Fields value={unwrap(value) as Record<string, unknown>} depth={depth + 1} />;
}

function Fields({ value, depth }: { value: Record<string, unknown>; depth: number }) {
  return (
    <dl className="doc-card__fields">
      {entriesOf(value).map(([key, child]) => (
        <div key={key} className="doc-card__field">
          <dt className="doc-card__key">{key}</dt>
          <dd>
            <Value value={child} depth={depth} />
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * One document as a readable card, for a detail view (a dashboard variable `$id` filters the
 * query, the card shows the match). With several documents it pages through them.
 */
function CardPanel({ documents = [], options }: PanelProps<CardOptions>) {
  const { t, language } = useI18n();
  const headingId = useId();
  const [index, setIndex] = useState(0);
  const [page, setPage] = useState(0);
  const position = Math.min(index, documents.length - 1);
  const set = documents[position];
  const count = set?.documents.length ?? 0;
  const current = Math.min(page, count - 1);
  const document = set?.documents[current];
  if (set === undefined || document === undefined) {
    return <EmptyPanel reason="noData" />;
  }
  const titleValue = valueAt(document, options.titlePath.trim() === "" ? "_id" : options.titlePath);
  const heading =
    titleValue === undefined || isContainer(titleValue)
      ? t("documents.tree.document", { number: current + 1 })
      : valueSummary(t, titleValue, language);
  return (
    <div className="doc-panel">
      <div className="doc-panel__bar">
        <SetPicker
          count={documents.length}
          index={position}
          onChange={(next) => {
            setIndex(next);
            setPage(0);
          }}
        />
        {count > 1 ? (
          <div className="doc-card__pager">
            <button
              type="button"
              className="button button--ghost button--small"
              disabled={current === 0}
              onClick={() => setPage(current - 1)}
            >
              {t("documents.card.previous")}
            </button>
            <span aria-live="polite">
              {t("documents.card.position", { number: current + 1, count })}
            </span>
            <button
              type="button"
              className="button button--ghost button--small"
              disabled={current >= count - 1}
              onClick={() => setPage(current + 1)}
            >
              {t("documents.card.next")}
            </button>
          </div>
        ) : null}
      </div>
      <article className="doc-card" aria-labelledby={headingId}>
        <h3 className="doc-card__title" id={headingId}>
          {heading}
        </h3>
        {isRecord(unwrap(document)) ? (
          <Fields value={unwrap(document) as Record<string, unknown>} depth={0} />
        ) : (
          <Value value={document} depth={0} />
        )}
      </article>
    </div>
  );
}

function CardEditor({ options, onChange }: PanelEditorProps<CardOptions>) {
  const { t } = useI18n();
  const id = useId();
  const hintId = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {t("documents.card.titlePath")}
      </label>
      <p className="field__hint" id={hintId}>
        {t("documents.card.titlePathHint")}
      </p>
      <input
        id={id}
        className="input input--mono"
        value={options.titlePath}
        aria-describedby={hintId}
        onChange={(event) => onChange({ titlePath: event.currentTarget.value })}
      />
    </div>
  );
}

export const documentCardPanel: PanelPlugin<CardOptions> = {
  type: "document",
  name: "documents.panels.card",
  shapes: ["documents"],
  options: (stored) => ({
    titlePath: isRecord(stored) && typeof stored.titlePath === "string" ? stored.titlePath : "",
  }),
  Panel: CardPanel,
  Editor: CardEditor,
};
