import { useId } from "react";
import type { DocumentSet, Notice } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import "./documents.css";

/**
 * What the server sends beside the documents (docs/api/datasources.md, "The documents shape"):
 * notices and the query as executed. Read defensively until the generated `DocumentSet` of this
 * branch has both fields.
 */
export function documentsMeta(set: DocumentSet): {
  notices: Notice[];
  executedQuery?: string;
} {
  const wire = set as DocumentSet & { notices?: unknown; executedQuery?: unknown };
  const notices = Array.isArray(wire.notices) ? (wire.notices as Notice[]) : [];
  return typeof wire.executedQuery === "string"
    ? { notices, executedQuery: wire.executedQuery }
    : { notices };
}

/** Which result a document panel shows, when several queries answered with documents. */
export function SetPicker({
  count,
  index,
  onChange,
}: {
  count: number;
  index: number;
  onChange: (index: number) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  if (count < 2) {
    return null;
  }
  return (
    <div className="preference">
      <label htmlFor={id}>{t("dashboards.panels.result")}</label>
      <select
        id={id}
        className="select"
        value={index}
        onChange={(event) => onChange(Number(event.currentTarget.value))}
      >
        {Array.from({ length: count }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: one entry per result, in order
          <option key={i} value={i}>
            {t("dashboards.panels.resultNumber", { number: i + 1 })}
          </option>
        ))}
      </select>
    </div>
  );
}

/** How many documents the set holds, and whether the source had more. */
export function SetSummary({ set }: { set: DocumentSet }) {
  const { t, language } = useI18n();
  const count = new Intl.NumberFormat(language).format(set.documents.length);
  return (
    <p className="doc-panel__summary">
      {t("documents.summary.count", { count })}
      {set.truncated === undefined
        ? ""
        : ` ${t("documents.summary.truncated", {
            limit: new Intl.NumberFormat(language).format(set.truncated.limit),
          })}`}
      {set.nextCursor === undefined ? "" : ` ${t("documents.summary.more")}`}
    </p>
  );
}
