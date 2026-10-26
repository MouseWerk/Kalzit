import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import type { PanelModel } from "../dashboards/model";
import { datasourcesQuery } from "../datasources/api";
import { KindMark, kindSummary } from "../datasources/kindMarks";
import { visualizationName } from "./visualization";
import "./analyses.css";

/** How a new panel begins: its own query, a saved analysis, or a copy of another panel. */
export type PanelStart = "new" | "analysis" | "panel";

const STARTS: readonly PanelStart[] = ["new", "analysis", "panel"];

const LABELS = {
  new: ["analyses.start.new", "analyses.start.newHint"],
  analysis: ["analyses.start.analysis", "analyses.start.analysisHint"],
  panel: ["analyses.start.panel", "analyses.start.panelHint"],
} as const;

export function PanelStartChoice({
  value,
  onChange,
  withPanels,
}: {
  value: PanelStart;
  onChange: (start: PanelStart) => void;
  /** Whether the dashboard has other panels to copy. */
  withPanels: boolean;
}) {
  const { t } = useI18n();
  const name = useId();
  return (
    <fieldset className="panel-start">
      <legend className="visually-hidden">{t("analyses.start.label")}</legend>
      {STARTS.filter((start) => start !== "panel" || withPanels).map((start) => (
        <label key={start} className="panel-start__option">
          <input
            type="radio"
            name={name}
            className="panel-start__input"
            checked={value === start}
            onChange={() => onChange(start)}
          />
          <span className="analysis-row__title">
            <span className="panel-start__label">{t(LABELS[start][0])}</span>
            <span className="analysis-row__detail">{t(LABELS[start][1])}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/** "From another panel": one of the dashboard's panels, copied with its queries and look. */
export function PanelCopyPicker({
  panels,
  onApply,
}: {
  panels: readonly PanelModel[];
  onApply: (panel: PanelModel) => void;
}) {
  const { t } = useI18n();
  const name = useId();
  const [chosen, setChosen] = useState<string | undefined>(panels[0]?.id);
  const panel = panels.find((p) => p.id === chosen);
  return (
    <section className="panel-copy" aria-label={t("analyses.start.panel")}>
      <fieldset className="radio-group">
        <legend className="visually-hidden">{t("analyses.start.panelPick")}</legend>
        {panels.map((p) => (
          <label key={p.id} className="radio">
            <input
              type="radio"
              name={name}
              checked={chosen === p.id}
              onChange={() => setChosen(p.id)}
            />
            <span>
              {p.title === "" ? t("dashboards.panel.untitled") : p.title}{" "}
              <span className="analysis-row__detail">{visualizationName(t, p.type)}</span>
            </span>
          </label>
        ))}
      </fieldset>
      <div className="analysis-picker__foot">
        <span className="analysis-row__detail">{t("analyses.start.panelCopyHint")}</span>
        <button
          type="button"
          className="button button--primary"
          disabled={panel === undefined}
          onClick={() => panel !== undefined && onApply(panel)}
        >
          {t("analyses.start.panelApply")}
        </button>
      </div>
    </section>
  );
}

/**
 * The queries tab of a linked panel: the analysis named, its queries read-only, and the ways to
 * change them (in Explore, or by unlinking into a copy).
 */
export function LinkedQueryHeader({
  orgId,
  analysisId,
  title,
  version,
  refIds,
  datasourceId,
  onUnlink,
  onRemove,
}: {
  orgId: string;
  analysisId: string;
  title: string;
  version: number | undefined;
  refIds: readonly string[];
  datasourceId: string | undefined;
  onUnlink: () => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const sources = useQuery(datasourcesQuery(orgId));
  const source = sources.data?.find((s) => s.id === datasourceId);
  const sourceText =
    source === undefined ? "" : `${source.name} (${kindSummary(t, source.kind) ?? source.kind})`;
  return (
    <article className="linked-query" aria-label={t("analyses.linked.label", { title })}>
      <header className="linked-query__head">
        <span className="linked-query__refs">{refIds.join(", ")}</span>
        {source === undefined ? null : <KindMark kind={source.kind} small />}
        <span className="analysis-row__title">
          <span className="linked-query__title">{title}</span>
          <span className="analysis-row__detail">
            {version === undefined
              ? sourceText
              : t("analyses.linked.detail", { source: sourceText, version })}
          </span>
        </span>
        <span className="linked-query__actions">
          <Link
            to="/explore"
            search={{ analysis: analysisId }}
            className="button button--secondary button--small"
          >
            {t("analyses.linked.edit")}
          </Link>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onUnlink}
          >
            {t("analyses.linked.unlink")}
          </button>
          <button type="button" className="button button--ghost button--small" onClick={onRemove}>
            {t("analyses.linked.remove")}
          </button>
        </span>
      </header>
      <p className="linked-query__note">{t("analyses.linked.note")}</p>
    </article>
  );
}
