import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type KeyboardEvent, useEffect, useId, useState } from "react";
import { asSteps } from "../../analysis/steps";
import type { TimeRange } from "../../api/generated/shapes";
import { FormAlert } from "../../components/FormAlert";
import { useI18n } from "../../i18n/i18n";
import { PanelHostContext } from "../../panels/host";
import type { PanelModel } from "../dashboards/model";
import { PanelBody } from "../dashboards/PanelCard";
import { outcomesOf } from "../dashboards/results";
import { intervalFor, MAX_DATA_POINTS } from "../dashboards/timeRange";
import { errorMessage } from "../dashboards/ui/errors";
import { datasourcesQuery } from "../datasources/api";
import { KindMark } from "../datasources/kindMarks";
import { ANALYSES_KEY, type Analysis, analysisQuery, fetchAnalyses, runAnalysis } from "./api";
import { visualizationName } from "./visualization";
import "./analyses.css";

/** Linked: the panel follows the analysis's saves. Copy: the panel holds its own queries. */
export type ApplyMode = "linked" | "copy";

type Scope = "all" | "team" | "mine";

/** Pause in typing after which the search runs. */
const SEARCH_DELAY_MS = 200;
/** The picker shows the best matches; a search narrows the rest. */
const PICK_LIMIT = 50;

interface AnalysisPickerProps {
  orgId: string;
  meId: string;
  /** The dashboard's owner team: offered as a scope of its own. */
  team?: { id: string; name: string } | null | undefined;
  /** The dashboard's range, which the preview and a linked panel run with. */
  range: TimeRange;
  onApply: (analysis: Analysis, mode: ApplyMode) => void;
}

/** Why an analysis cannot go into this dashboard's panel, or null when it can. */
function blockedReason(t: ReturnType<typeof useI18n>["t"], analysis: Analysis): string | null {
  if (analysis.teamOnly) {
    return t("analyses.picker.teamOnly");
  }
  if (!analysis.mayQuery) {
    return t("analyses.picker.noQueryRight");
  }
  return null;
}

/**
 * "From saved analysis" in the panel editor: a searchable list on the left, the chosen analysis
 * with a live preview on the right, and how it joins the panel (linked by default, or a copy).
 */
export function AnalysisPicker({ orgId, meId, team, range, onApply }: AnalysisPickerProps) {
  const { t } = useI18n();
  const ids = useId();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const [scope, setScope] = useState<Scope>(team === undefined || team === null ? "all" : "team");
  const [chosen, setChosen] = useState<string | null>(null);
  const [mode, setMode] = useState<ApplyMode>("linked");
  useEffect(() => {
    const timer = window.setTimeout(() => setQ(text.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text]);
  const list = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "pick", q, scope],
    queryFn: ({ signal }) =>
      fetchAnalyses(
        orgId,
        {
          q,
          sort: "updated",
          limit: PICK_LIMIT,
          createdBy: scope === "mine" ? meId : undefined,
          ownerTeamId: scope === "team" ? (team?.id ?? undefined) : undefined,
        },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const sources = useQuery(datasourcesQuery(orgId));
  const items = list.data?.items ?? [];
  const selectable = items.filter((item) => blockedReason(t, item) === null);
  const current = items.find((item) => item.id === chosen) ?? selectable[0];
  const sourceOf = (analysis: Analysis) =>
    sources.data?.find((source) => source.id === analysis.datasourceIds[0]);

  function onListKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    event.preventDefault();
    const index = current === undefined ? -1 : selectable.indexOf(current);
    const next =
      selectable[
        event.key === "ArrowDown"
          ? Math.min(index + 1, selectable.length - 1)
          : Math.max(index - 1, 0)
      ];
    if (next !== undefined) {
      setChosen(next.id);
    }
  }

  const scopes: { key: Scope; label: string }[] = [
    { key: "all", label: t("analyses.picker.scopeAll") },
    ...(team === undefined || team === null
      ? []
      : [{ key: "team" as const, label: t("analyses.picker.scopeTeam") }]),
    { key: "mine", label: t("analyses.picker.scopeMine") },
  ];

  return (
    <section className="analysis-picker" aria-label={t("analyses.picker.label")}>
      <div className="analysis-picker__list">
        <div className="analysis-picker__filters">
          <label className="visually-hidden" htmlFor={`${ids}-search`}>
            {t("analyses.list.search")}
          </label>
          <input
            id={`${ids}-search`}
            type="search"
            className="input"
            placeholder={t("analyses.list.search")}
            value={text}
            onChange={(event) => setText(event.currentTarget.value)}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form group */}
          <div className="analysis-segmented" role="group" aria-label={t("analyses.picker.scope")}>
            {scopes.map((entry) => (
              <button
                key={entry.key}
                type="button"
                className="analysis-segmented__item"
                aria-pressed={scope === entry.key}
                onClick={() => setScope(entry.key)}
              >
                {entry.label}
              </button>
            ))}
          </div>
        </div>
        {list.isError ? <FormAlert>{errorMessage(t, list.error)}</FormAlert> : null}
        {list.isPending ? (
          <p className="loading">{t("common.loading")}</p>
        ) : items.length === 0 ? (
          <p className="field__hint">{t("analyses.picker.empty")}</p>
        ) : (
          <div
            className="analysis-picker__options"
            role="listbox"
            aria-label={t("analyses.picker.options")}
            aria-activedescendant={current === undefined ? undefined : `${ids}-${current.id}`}
            tabIndex={0}
            onKeyDown={onListKey}
          >
            {items.map((item) => {
              const reason = blockedReason(t, item);
              const source = sourceOf(item);
              return (
                // biome-ignore lint/a11y/useFocusableInteractive: the listbox keeps focus (aria-activedescendant).
                // biome-ignore lint/a11y/useKeyWithClickEvents: the listbox takes the arrow keys.
                <div
                  key={item.id}
                  id={`${ids}-${item.id}`}
                  role="option"
                  className="analysis-picker__option"
                  aria-selected={current?.id === item.id}
                  aria-disabled={reason === null ? undefined : true}
                  onClick={() => {
                    if (reason === null) {
                      setChosen(item.id);
                    }
                  }}
                >
                  {source === undefined ? null : <KindMark kind={source.kind} small />}
                  <span className="analysis-row__title">
                    <span className="truncate" title={item.title}>
                      {item.title}
                    </span>
                    <span className="analysis-row__detail">{reason ?? source?.name ?? ""}</span>
                  </span>
                </div>
              );
            })}
          </div>
        )}
        <p className="analysis-picker__count">
          {t(items.length === 1 ? "analyses.picker.countOne" : "analyses.picker.countMany", {
            count: items.length,
          })}
        </p>
      </div>
      {current === undefined ? null : (
        <PickerPreview
          key={current.id}
          orgId={orgId}
          analysis={current}
          range={range}
          mode={mode}
          onMode={setMode}
          onApply={(full) => onApply(full, mode)}
        />
      )}
    </section>
  );
}

function PickerPreview({
  orgId,
  analysis,
  range,
  mode,
  onMode,
  onApply,
}: {
  orgId: string;
  analysis: Analysis;
  range: TimeRange;
  mode: ApplyMode;
  onMode: (mode: ApplyMode) => void;
  onApply: (analysis: Analysis) => void;
}) {
  const { t } = useI18n();
  const ids = useId();
  const full = useQuery(analysisQuery(orgId, analysis.id));
  const sources = useQuery(datasourcesQuery(orgId));
  const model = full.data?.model;
  const refIds = (model?.targets ?? []).filter((x) => x.hide !== true).map((x) => x.refId);
  const result = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "preview", analysis.id, full.data?.version ?? 0, range],
    queryFn: async ({ signal }) =>
      outcomesOf(
        await runAnalysis(
          orgId,
          analysis.id,
          { timeRange: range, intervalMs: intervalFor(range), maxDataPoints: MAX_DATA_POINTS },
          signal,
        ),
        refIds,
      ),
    enabled: model !== undefined,
    staleTime: 30_000,
  });
  if (full.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (full.isError || model === undefined) {
    return <FormAlert>{errorMessage(t, full.error)}</FormAlert>;
  }
  const source = sources.data?.find((s) => s.id === model.targets[0]?.datasourceId);
  const panel: PanelModel = {
    id: "picker",
    type: model.visualization.type,
    title: "",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: model.targets,
    transformations: model.steps,
    options: model.visualization.options ?? {},
    fieldConfig: model.visualization.fieldConfig ?? {},
  };
  const steps = asSteps(model.steps).length;
  return (
    <div className="analysis-picker__preview">
      <header className="analysis-picker__head">
        <div>
          <h3 className="analysis-picker__title">{analysis.title}</h3>
          <p className="analysis-row__detail">
            {model.description === undefined ? "" : `${model.description} `}
            {t("analyses.picker.version", { version: analysis.version })}
          </p>
        </div>
        <Link
          to="/explore"
          search={{ analysis: analysis.id }}
          className="button button--ghost button--small"
        >
          {t("analyses.picker.viewInExplore")}
        </Link>
      </header>
      <div className="analysis-picker__chips">
        {source === undefined ? null : (
          <span className="analysis-chip">
            <KindMark kind={source.kind} small />
            {source.name}
          </span>
        )}
        <span className="analysis-chip">
          {t(model.targets.length === 1 ? "analyses.queriesOne" : "analyses.queriesMany", {
            count: model.targets.length,
          })}
        </span>
        <span className="analysis-chip">
          {t(steps === 1 ? "analyses.stepsOne" : "analyses.stepsMany", { count: steps })}
        </span>
        <span className="analysis-chip">
          {t("analyses.save.visualization", {
            name: visualizationName(t, model.visualization.type),
          })}
        </span>
        <span className="analysis-chip">{t("analyses.picker.rangeFollows")}</span>
      </div>
      <div className="analysis-picker__viz">
        <PanelHostContext value={{ orgId }}>
          <PanelBody
            panel={panel}
            title={analysis.title}
            range={range}
            pending={result.isPending}
            error={result.error}
            outcomes={result.data ?? []}
            revision={String(result.dataUpdatedAt)}
          />
        </PanelHostContext>
      </div>
      <fieldset className="radio-group analysis-picker__mode">
        <legend className="field__label">{t("analyses.picker.applyAs")}</legend>
        <label className="analysis-picker__choice">
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "linked"}
            onChange={() => onMode("linked")}
            aria-describedby={`${ids}-linked`}
          />
          <span className="analysis-row__title">
            <span>{t("analyses.picker.linked")}</span>
            <span className="analysis-row__detail" id={`${ids}-linked`}>
              {t("analyses.picker.linkedHint")}
            </span>
          </span>
        </label>
        <label className="analysis-picker__choice">
          <input
            type="radio"
            name={`${ids}-mode`}
            checked={mode === "copy"}
            onChange={() => onMode("copy")}
            aria-describedby={`${ids}-copy`}
          />
          <span className="analysis-row__title">
            <span>{t("analyses.picker.copy")}</span>
            <span className="analysis-row__detail" id={`${ids}-copy`}>
              {t("analyses.picker.copyHint")}
            </span>
          </span>
        </label>
      </fieldset>
      <div className="analysis-picker__foot">
        <span className="analysis-row__detail">{t("analyses.picker.viewers")}</span>
        <button
          type="button"
          className="button button--primary"
          onClick={() => full.data !== undefined && onApply(full.data)}
        >
          {t("analyses.picker.apply")}
        </button>
      </div>
    </div>
  );
}
