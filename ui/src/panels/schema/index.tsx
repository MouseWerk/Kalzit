import { useId, useRef, useState } from "react";
import type { FieldSchema } from "../../api/generated/shapes";
import { typeLabel } from "../../documents/labels";
import { outliersOf, schemaOf } from "../../documents/schema";
import { SetPicker } from "../../documents/shared";
import { useI18n } from "../../i18n/i18n";
import { EmptyPanel } from "../shared";
import { useStyleVars } from "../styleVars";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import { useElementSize } from "../useElementSize";
import "../../documents/documents.css";

export type SchemaOptions = Record<string, never>;

/** Fixed row height in px, as in the table panel, so 1,000 paths draw only what is in view. */
export const SCHEMA_ROW_HEIGHT = 32;
const OVERSCAN = 10;

function Meter({ share }: { share: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useStyleVars(ref, { "--share": `${Math.round(share * 1000) / 10}%` });
  return (
    <span className="schema__meter" aria-hidden="true">
      <span className="schema__meter-fill" ref={ref} />
    </span>
  );
}

/**
 * Every field path of the result with its types and coverage, and the outliers MongoDB users look
 * for first: fields missing in some documents and fields of mixed types.
 */
function SchemaPanel({ documents = [], title }: PanelProps<SchemaOptions>) {
  const { t, language } = useI18n();
  const searchId = useId();
  const onlyId = useId();
  const scrollRef = useRef<HTMLElement>(null);
  const topRef = useRef<HTMLTableRowElement>(null);
  const bottomRef = useRef<HTMLTableRowElement>(null);
  const { height } = useElementSize(scrollRef);
  const [index, setIndex] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const [search, setSearch] = useState("");
  const [onlyOutliers, setOnlyOutliers] = useState(false);
  const position = Math.min(index, documents.length - 1);
  const set = documents[position];
  const percent = new Intl.NumberFormat(language, { style: "percent", maximumFractionDigits: 1 });
  const number = new Intl.NumberFormat(language);

  const schema: FieldSchema[] = set === undefined ? [] : schemaOf(set);
  const outlierCount = schema.filter((field) => {
    const o = outliersOf(field);
    return o.partial || o.mixed;
  }).length;
  const needle = search.trim().toLowerCase();
  const fields = schema.filter((field) => {
    if (needle !== "" && !field.path.toLowerCase().includes(needle)) {
      return false;
    }
    const o = outliersOf(field);
    return !onlyOutliers || o.partial || o.mixed;
  });
  const total = fields.length;
  const visible = Math.ceil(height / SCHEMA_ROW_HEIGHT);
  const start = Math.max(0, Math.floor(scrollTop / SCHEMA_ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(total, start + visible + 2 * OVERSCAN);

  useStyleVars(scrollRef, { "--vt-row-height": `${SCHEMA_ROW_HEIGHT}px` });
  useStyleVars(topRef, { "--vt-spacer": `${start * SCHEMA_ROW_HEIGHT}px` });
  useStyleVars(bottomRef, { "--vt-spacer": `${(total - end) * SCHEMA_ROW_HEIGHT}px` });

  if (set === undefined) {
    return <EmptyPanel reason="noData" />;
  }

  const rows = [];
  for (let i = start; i < end; i++) {
    const field = fields[i] as FieldSchema;
    const outliers = outliersOf(field);
    const notes = [
      outliers.partial
        ? t("documents.schema.missing", { share: percent.format(1 - field.coverage) })
        : "",
      outliers.mixed ? t("documents.schema.mixed") : "",
    ].filter((note) => note !== "");
    rows.push(
      <tr
        key={field.path}
        className={notes.length > 0 ? "vt__row schema__row--outlier" : "vt__row"}
        aria-rowindex={i + 2}
      >
        <td className="vt__cell schema__path" title={field.path}>
          {field.path}
        </td>
        <td className="vt__cell">
          {field.types
            .map((type) => `${typeLabel(t, type.name)} ${percent.format(type.share)}`)
            .join(", ")}
        </td>
        <td className="vt__cell schema__coverage">
          <Meter share={field.coverage} />
          <span>{percent.format(field.coverage)}</span>
        </td>
        <td className="vt__cell">{notes.join(", ")}</td>
      </tr>,
    );
  }

  return (
    <div className="doc-panel">
      <div className="doc-panel__bar">
        <SetPicker count={documents.length} index={position} onChange={setIndex} />
        <div className="preference">
          <label htmlFor={searchId}>{t("documents.schema.search")}</label>
          <input
            id={searchId}
            className="input"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.currentTarget.value)}
          />
        </div>
        <label className="checkbox" htmlFor={onlyId}>
          <input
            id={onlyId}
            type="checkbox"
            checked={onlyOutliers}
            onChange={(event) => setOnlyOutliers(event.currentTarget.checked)}
          />
          {t("documents.schema.onlyOutliers")}
        </label>
        <p className="doc-panel__summary">
          {t("documents.schema.summary", {
            paths: number.format(schema.length),
            documents: number.format(set.documents.length),
            outliers: number.format(outlierCount),
          })}
        </p>
      </div>
      {total === 0 ? (
        <p className="panel-empty">{t("documents.schema.none")}</p>
      ) : (
        <section
          className="vt"
          ref={scrollRef}
          // biome-ignore lint/a11y/noNoninteractiveTabindex: a scroll container needs focus to scroll by keyboard
          tabIndex={0}
          aria-label={title}
          onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
        >
          <table className="vt__table" aria-rowcount={total + 1}>
            <thead>
              <tr aria-rowindex={1}>
                <th scope="col" className="vt__head schema__head">
                  {t("documents.schema.path")}
                </th>
                <th scope="col" className="vt__head schema__head">
                  {t("documents.schema.types")}
                </th>
                <th scope="col" className="vt__head schema__head">
                  {t("documents.schema.coverage")}
                </th>
                <th scope="col" className="vt__head schema__head">
                  {t("documents.schema.notes")}
                </th>
              </tr>
            </thead>
            <tbody>
              {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
              <tr className="vt__spacer" ref={topRef} role="presentation">
                <td colSpan={4} />
              </tr>
              {rows}
              {/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: an empty spacer, not a row */}
              <tr className="vt__spacer" ref={bottomRef} role="presentation">
                <td colSpan={4} />
              </tr>
            </tbody>
          </table>
        </section>
      )}
    </div>
  );
}

function SchemaEditor(_: PanelEditorProps<SchemaOptions>) {
  const { t } = useI18n();
  return <p className="field__hint">{t("documents.panels.schemaHint")}</p>;
}

export const schemaPanel: PanelPlugin<SchemaOptions> = {
  type: "schema",
  name: "documents.panels.schema",
  shapes: ["documents"],
  options: () => ({}),
  Panel: SchemaPanel,
  Editor: SchemaEditor,
};
