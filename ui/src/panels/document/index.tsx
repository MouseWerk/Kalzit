import { useId, useState } from "react";
import { isRecord } from "../../api/client";
import { typeLabel, valueSummary } from "../../documents/labels";
import { valueAt } from "../../documents/paths";
import { MAX_PATH_CHARS } from "../../documents/projection";
import { SetPicker } from "../../documents/shared";
import { entriesOf, isContainer, typeOf, unwrap } from "../../documents/values";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import { EmptyPanel } from "../shared";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../../documents/documents.css";
import { DocumentCardPreview } from "../picker/previews";
import {
  ClickVariableOptions,
  clickOption,
  MAX_VARIABLE_CHARS,
  useClickOptionTexts,
  useClickVariable,
  variableText,
} from "../variableClick";

export interface CardOptions {
  /** The field whose value titles the card (`name`); `_id` when empty. */
  titlePath: string;
  /** Dashboard variable a click on a value of the card sets; empty sets none. */
  variable: string;
  /** Path in the shown document the variable takes; empty takes the clicked value. */
  variablePath: string;
}

export function parseCardOptions(stored: unknown): CardOptions {
  const value = isRecord(stored) ? stored : {};
  return {
    titlePath: typeof value.titlePath === "string" ? value.titlePath : "",
    variable: clickOption(value.variable, MAX_VARIABLE_CHARS, true),
    variablePath: clickOption(value.variablePath, MAX_PATH_CHARS),
  };
}

/** A click on a value of the card: given only when the card sets a variable. */
type Pick = ((value: unknown) => void) | undefined;

/** Below this depth nested values are summarized, so a deep document stays a readable card. */
const MAX_DEPTH = 6;
/** Array elements shown at first, and added by each "Show more". */
export const CARD_PAGE = 50;

function Value({ value, depth, pick }: { value: unknown; depth: number; pick: Pick }) {
  const { t, language } = useI18n();
  const [shown, setShown] = useState(CARD_PAGE);
  const entries = entriesOf(value);
  if (!isContainer(value) || depth >= MAX_DEPTH || entries.length === 0) {
    const summary = valueSummary(t, value, language);
    return (
      <span className="doc-card__value">
        {pick === undefined || isContainer(value) ? (
          <span>{summary}</span>
        ) : (
          <button type="button" className="value-pick" onClick={() => pick(value)}>
            {summary}
          </button>
        )}
        <span className="doc-tree__type">{typeLabel(t, typeOf(value))}</span>
      </span>
    );
  }
  if (Array.isArray(value)) {
    return (
      <>
        <ol className="doc-card__list">
          {entries.slice(0, shown).map(([i, item]) => (
            <li key={i}>
              <Value value={item} depth={depth + 1} pick={pick} />
            </li>
          ))}
        </ol>
        {entries.length > shown ? (
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => setShown(shown + CARD_PAGE)}
          >
            {t("documents.tree.showMore", {
              count: Math.min(CARD_PAGE, entries.length - shown),
              rest: entries.length - shown,
            })}
          </button>
        ) : null}
      </>
    );
  }
  return <Fields value={unwrap(value) as Record<string, unknown>} depth={depth + 1} pick={pick} />;
}

function Fields({
  value,
  depth,
  pick,
}: {
  value: Record<string, unknown>;
  depth: number;
  pick: Pick;
}) {
  return (
    <dl className="doc-card__fields">
      {entriesOf(value).map(([key, child]) => (
        <div key={key} className="doc-card__field">
          <dt className="doc-card__key">{key}</dt>
          <dd>
            <Value value={child} depth={depth} pick={pick} />
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
  const clicked = useClickVariable(options.variable);
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
  // A click on any value sets the variable: to the value at the option's path in this document,
  // or to the clicked value itself.
  const pick: Pick =
    clicked.variable === null
      ? undefined
      : (value) =>
          clicked.click(
            variableText(
              options.variablePath === "" ? value : valueAt(document, options.variablePath),
            ),
          );
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
          <Fields value={unwrap(document) as Record<string, unknown>} depth={0} pick={pick} />
        ) : (
          <Value value={document} depth={0} pick={pick} />
        )}
      </article>
      {clicked.variable === null ? null : (
        <p className="visually-hidden" role="status" aria-live="polite">
          {clicked.announcement}
        </p>
      )}
    </div>
  );
}

function CardEditor({ options, onChange }: PanelEditorProps<CardOptions>) {
  const { t } = useI18n();
  const host = usePanelHost();
  const id = useId();
  const hintId = useId();
  const variableId = useId();
  const texts = useClickOptionTexts(
    t("panels.variable.triggerCard"),
    t("panels.variable.path"),
    t("panels.variable.pathHintCard"),
  );
  return (
    <>
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
          maxLength={MAX_PATH_CHARS}
          aria-describedby={hintId}
          onChange={(event) => onChange({ ...options, titlePath: event.currentTarget.value })}
        />
      </div>
      <ClickVariableOptions
        id={variableId}
        names={host.variables?.names ?? []}
        variable={options.variable}
        source={options.variablePath}
        texts={texts}
        maxLength={MAX_PATH_CHARS}
        onChange={(patch) =>
          onChange(
            parseCardOptions({
              ...options,
              ...(patch.variable === undefined ? {} : { variable: patch.variable }),
              ...(patch.source === undefined ? {} : { variablePath: patch.source }),
            }),
          )
        }
      />
    </>
  );
}

export const documentCardPanel: PanelPlugin<CardOptions> = {
  type: "document",
  name: "documents.panels.card",
  description: "documents.describe.card",
  Preview: DocumentCardPreview,
  shapes: ["documents"],
  options: parseCardOptions,
  Panel: CardPanel,
  Editor: CardEditor,
};
