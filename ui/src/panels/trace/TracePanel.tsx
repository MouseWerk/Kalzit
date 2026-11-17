import { useId, useState } from "react";
import type { Notice, Span } from "../../api/generated/shapes";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { noticeText } from "../../features/datasources/reasons";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import { CheckboxField, EmptyPanel, NumberField, SelectField } from "../shared";
import type { PanelEditorProps, PanelProps } from "../types";
import {
  ClickVariableOptions,
  useClickOptionTexts,
  useClickVariable,
  variableText,
} from "../variableClick";
import {
  formatDuration,
  spanValue,
  summariesOfFrame,
  summariesOfTraces,
  type TraceSummary,
  tracesOf,
} from "./model";
import {
  MAX_COLLAPSE_DEPTH,
  MAX_SOURCE_CHARS,
  parseTraceOptions,
  TRACE_COLUMNS,
  type TracePanelOptions,
  type TraceViewMode,
} from "./options";
import type { SpanActions } from "./SpanDetail";
import { TraceList } from "./TraceList";
import { Waterfall } from "./Waterfall";
import "./trace.css";
import "../panels.css";

/**
 * Traces as a list or one trace as a waterfall (board frames 1, 2 and 5). It draws a `trace`
 * result as it is, and a table of traces (a search's answer, a trace table step) as the list;
 * "automatic" shows the waterfall when the result holds exactly one trace.
 */
export function TracePanel({ traces = [], frames, options, title }: PanelProps<TracePanelOptions>) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const clicked = useClickVariable(options.variable);
  const pickId = useId();
  // The trace opened from the list, while the result holds its spans.
  const [opened, setOpened] = useState<string | null>(null);

  const views = traces.flatMap((set) =>
    tracesOf(set.trace).map((view) => ({ view, datasourceId: set.datasourceId })),
  );
  const listed: TraceSummary[] = [
    ...summariesOfTraces(views.map((entry) => entry.view)),
    ...frames.flatMap((frame) => summariesOfFrame(frame) ?? []),
  ];
  const notices: Notice[] = [
    ...traces.flatMap((set) => set.trace.notices ?? []),
    ...frames.flatMap((frame) =>
      summariesOfFrame(frame) === null ? [] : (frame.meta?.notices ?? []),
    ),
  ];
  const noticeBar =
    notices.length === 0 ? null : (
      <div className="notice trace__notice" role="status">
        <Icon name="info" />
        <div>
          {notices.map((notice) => (
            <p key={`${notice.code}:${JSON.stringify(notice.params ?? {})}`}>
              {noticeText(t, notice)}
            </p>
          ))}
        </div>
      </div>
    );
  const announce =
    clicked.variable === null ? null : (
      <p className="visually-hidden" role="status" aria-live="polite">
        {clicked.announcement}
      </p>
    );

  if (listed.length === 0) {
    const { widen, reset } = host.traces ?? {};
    // A search without hits in Explore names the next step; elsewhere the panel's usual words.
    if (widen === undefined && reset === undefined) {
      return <EmptyPanel reason="noData" />;
    }
    return (
      <EmptyState
        icon="search"
        title={t("traces.empty.title")}
        actions={
          <>
            {widen === undefined ? null : (
              <button type="button" className="button button--secondary" onClick={widen}>
                {t("dashboards.time.last24h")}
              </button>
            )}
            {reset === undefined ? null : (
              <button type="button" className="button button--ghost" onClick={reset}>
                {t("datasources.filter.reset")}
              </button>
            )}
          </>
        }
      >
        {t("traces.empty.text")}
      </EmptyState>
    );
  }

  const one = views.length === 1 && listed.length === 1;
  const picked = views.find((entry) => entry.view.traceId === opened);
  const waterfall =
    options.view === "waterfall" || (options.view === "auto" && one) || picked !== undefined;

  if (waterfall && views.length > 0) {
    const shown = picked ?? (views[0] as (typeof views)[number]);
    const { view, datasourceId } = shown;
    const variable = clicked.variable;
    const actions: SpanActions = {
      filter: host.traces?.filter,
      openTrace: host.traces?.open,
      variable:
        variable === null ? undefined : { name: variable, set: (value) => clicked.click(value) },
    };
    const openInExplore = host.openInExplore;
    // On a dashboard the panel is compact; Explore and the editor give the trace the page.
    const compact = host.view !== undefined;
    return (
      <div className="trace">
        {noticeBar}
        <div className="trace__bar">
          {picked !== undefined ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => setOpened(null)}
            >
              <Icon name="back" />
              {t("traces.backToList")}
            </button>
          ) : host.traces?.back === undefined ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={host.traces.back}
            >
              <Icon name="back" />
              {t("traces.backToList")}
            </button>
          )}
          {picked === undefined && views.length > 1 ? (
            <div className="preference">
              <label htmlFor={pickId}>{t("analysis.shape.trace")}</label>
              <Select id={pickId} value={view.traceId} onChange={(next) => setOpened(next)}>
                {views.map((entry) => (
                  <option key={entry.view.traceId} value={entry.view.traceId}>
                    {entry.view.traceId.slice(0, 8)} · {entry.view.root.service}
                  </option>
                ))}
              </Select>
            </div>
          ) : null}
          <h3 className="trace__title">
            {view.root.service}: {view.root.operation}
          </h3>
          {view.errors > 0 ? <span className="trace-error">{t("traces.error")}</span> : null}
          {compact ? (
            <span className="trace__foot">
              {formatDuration(view.duration, language)} ·{" "}
              {t("traces.spanCount", { count: view.spans.length })}
            </span>
          ) : null}
          <span className="trace__spacer" />
          {compact && openInExplore !== undefined && datasourceId !== "" ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => openInExplore(datasourceId, { traceId: view.traceId })}
            >
              <Icon name="external" />
              {t("ai.chat.openInExplore")}
            </button>
          ) : null}
        </div>
        <Waterfall
          key={view.traceId}
          trace={view}
          title={title}
          compact={compact}
          collapseDepth={options.collapseDepth}
          events={options.events}
          actions={actions}
          onSpanClick={
            variable === null || options.variableSource === ""
              ? undefined
              : (span: Span) => clicked.click(variableText(spanValue(span, options.variableSource)))
          }
        />
        {announce}
      </div>
    );
  }

  const open = host.traces?.open;
  const hasSpans = (traceId: string) => views.some((entry) => entry.view.traceId === traceId);
  const pick = (row: TraceSummary) => {
    if (clicked.variable !== null) {
      clicked.click(row.traceId);
    }
    if (hasSpans(row.traceId)) {
      // The spans are here already: the waterfall opens in place.
      if (clicked.variable === null) setOpened(row.traceId);
    } else {
      open?.(row.traceId);
    }
  };
  const clickable =
    clicked.variable !== null || open !== undefined || listed.some((row) => hasSpans(row.traceId));
  return (
    <div className="trace">
      {noticeBar}
      <TraceList
        rows={listed}
        columns={options.columns}
        chart={options.chart}
        title={title}
        selected={
          clicked.variable === null ? undefined : (host.linkValues?.[clicked.variable] as string)
        }
        onPick={clickable ? pick : undefined}
      />
      {clicked.variable === null ? null : (
        <p className="trace__foot">{t("traces.setsVariable", { name: clicked.variable })}</p>
      )}
      {announce}
    </div>
  );
}

const COLUMN_LABELS = {
  root: "traces.name",
  spans: "traces.col.spans",
  services: "traces.col.services",
  duration: "traces.duration",
  start: "traces.start",
  status: "traces.status",
} as const;

export function TraceEditor({ options, onChange }: PanelEditorProps<TracePanelOptions>) {
  const { t } = useI18n();
  const host = usePanelHost();
  const variableId = useId();
  const texts = useClickOptionTexts(
    t("traces.option.click"),
    t("traces.option.source"),
    t("traces.option.sourceHint"),
  );
  const set = (patch: Partial<TracePanelOptions>) =>
    onChange(parseTraceOptions({ ...options, ...patch }));
  return (
    <>
      <SelectField<TraceViewMode>
        label={t("graph.view.label")}
        hint={t("traces.option.viewHint")}
        value={options.view}
        choices={[
          ["auto", t("traces.view.auto")],
          ["list", t("traces.view.list")],
          ["waterfall", t("traces.view.waterfall")],
        ]}
        onChange={(view) => set({ view })}
      />
      <fieldset className="trace-columns" data-option="">
        <legend className="field__label">{t("traces.option.columns")}</legend>
        {TRACE_COLUMNS.map((column) => (
          <label key={column} className="checkbox">
            <input
              type="checkbox"
              checked={options.columns.includes(column)}
              onChange={(event) =>
                set({
                  columns: event.currentTarget.checked
                    ? [...options.columns, column]
                    : options.columns.filter((c) => c !== column),
                })
              }
            />
            <span>{t(COLUMN_LABELS[column])}</span>
          </label>
        ))}
      </fieldset>
      <CheckboxField
        label={t("traces.chart")}
        checked={options.chart}
        onChange={(chart) => set({ chart })}
      />
      <ClickVariableOptions
        id={variableId}
        names={host.variables?.names ?? []}
        variable={options.variable}
        source={options.variableSource}
        texts={texts}
        maxLength={MAX_SOURCE_CHARS}
        onChange={(patch) =>
          set({
            ...(patch.variable === undefined ? {} : { variable: patch.variable }),
            ...(patch.source === undefined ? {} : { variableSource: patch.source }),
          })
        }
      />
      <NumberField
        label={t("traces.option.collapse")}
        hint={t("traces.option.collapseHint")}
        value={options.collapseDepth === 0 ? undefined : options.collapseDepth}
        min={1}
        max={MAX_COLLAPSE_DEPTH}
        step={1}
        onChange={(depth) => set({ collapseDepth: depth ?? 0 })}
      />
      <CheckboxField
        label={t("traces.option.events")}
        checked={options.events}
        onChange={(events) => set({ events })}
      />
    </>
  );
}
