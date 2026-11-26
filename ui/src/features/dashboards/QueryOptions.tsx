import { useId, useState } from "react";
import type { TimeRange } from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { formatDuration } from "../../panels/fieldConfig/graphStyle";
import type { PanelModel } from "./model";
import { PanelExtras } from "./PanelExtras";
import {
  isCacheTimeout,
  isMaxDataPoints,
  isMinInterval,
  MAX_PANEL_DATA_POINTS,
  queryLimits,
} from "./queryLimits";
import { MAX_DATA_POINTS } from "./timeRange";
import "./panelEditor.css";

type Key = "maxDataPoints" | "minInterval" | "cacheTimeout" | "hideTimeNote";

/** The panel with `key` set to `value`, or without it when the value is empty. */
function withOption<K extends Key>(panel: PanelModel, key: K, value: PanelModel[K] | undefined) {
  const next = { ...panel };
  if (value === undefined || value === "" || value === false) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

/**
 * The panel's query options, a collapsible row above its queries (ParityEditors board, frame
 * 5): the most data points, the smallest interval, the own range and shift, the cache time and
 * whether the header names the own range. Collapsed, one sentence says what is set; every
 * "Auto" says what it picks. The server applies the same to the stored panel.
 */
export function QueryOptions({
  panel,
  range,
  onChange,
}: {
  panel: PanelModel;
  /** The range the preview runs with, for what "Auto" picks. */
  range: TimeRange;
  onChange: (change: (panel: PanelModel) => PanelModel) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const [open, setOpen] = useState(false);
  // What was typed, kept while it is not valid yet; the panel holds only valid values.
  const [pointsText, setPointsText] = useState(
    panel.maxDataPoints === undefined ? "" : String(panel.maxDataPoints),
  );
  const limits = queryLimits(panel, range);
  const number = (n: number) => n.toLocaleString(language);
  const autoPoints = t("dashboards.queryOptions.auto", { value: number(MAX_DATA_POINTS) });
  const interval = formatDuration(limits.intervalMs);
  const parts = [
    t("dashboards.queryOptions.summary.points", {
      value: panel.maxDataPoints === undefined ? autoPoints : number(panel.maxDataPoints),
    }),
    t("dashboards.queryOptions.summary.interval", { value: interval }),
    panel.timeFrom === undefined
      ? null
      : t("dashboards.queryOptions.summary.range", { value: panel.timeFrom }),
    panel.timeShift === undefined
      ? null
      : t("dashboards.queryOptions.summary.shift", { value: panel.timeShift }),
    panel.cacheTimeout === undefined
      ? null
      : t("dashboards.queryOptions.summary.cache", { value: panel.cacheTimeout }),
    panel.hideTimeNote === true ? t("dashboards.queryOptions.summary.noteHidden") : null,
  ].filter((part) => part !== null);
  const summary = parts.join(" · ");
  const pointsInvalid =
    pointsText.trim() !== "" && !isMaxDataPoints(Number(pointsText.trim()))
      ? t("dashboards.queryOptions.points.invalid", { max: number(MAX_PANEL_DATA_POINTS) })
      : undefined;
  const span = range.to - range.from;
  const spread = Math.max(1000, Math.round(span / limits.maxDataPoints));

  return (
    <section className="option-group query-options" aria-labelledby={`${id}-heading`}>
      <h3 className="option-group__heading" id={`${id}-heading`}>
        <button
          type="button"
          className="option-group__toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((current) => !current)}
        >
          <Icon name="chevron" className="option-group__chevron" />
          <span className="option-group__title">{t("dashboards.queryOptions.title")}</span>{" "}
          {open ? null : (
            <span className="option-group__summary truncate" title={summary}>
              {summary}
            </span>
          )}
        </button>
      </h3>
      <div className="option-group__body query-options__body" id={`${id}-body`} hidden={!open}>
        <div className="query-options__pair">
          <TextField
            label={t("dashboards.queryOptions.points.label")}
            hint={t("dashboards.queryOptions.points.hint")}
            value={pointsText}
            placeholder={autoPoints}
            inputMode="numeric"
            autoComplete="off"
            error={pointsInvalid}
            onValueChange={(text) => {
              setPointsText(text);
              const trimmed = text.trim();
              const value = Number(trimmed);
              if (trimmed === "") onChange((p) => withOption(p, "maxDataPoints", undefined));
              else if (isMaxDataPoints(value)) {
                onChange((p) => withOption(p, "maxDataPoints", value));
              }
            }}
          />
          <TextField
            label={t("dashboards.queryOptions.interval.label")}
            hint={t("dashboards.queryOptions.interval.hint")}
            value={panel.minInterval ?? ""}
            placeholder={t("dashboards.queryOptions.autoPlain")}
            mono
            autoComplete="off"
            error={
              panel.minInterval !== undefined && !isMinInterval(panel.minInterval)
                ? t("dashboards.queryOptions.interval.invalid")
                : undefined
            }
            onValueChange={(text) => onChange((p) => withOption(p, "minInterval", text.trim()))}
          />
        </div>
        <output className="query-options__result" aria-live="polite">
          <span>
            {t("dashboards.queryOptions.result")}
            <code className="query-options__macro">{`$__interval = ${interval}`}</code>
          </span>
          <span className="field__hint">
            {t(
              limits.raised
                ? "dashboards.queryOptions.resultRaised"
                : "dashboards.queryOptions.resultSpread",
              {
                span: formatDuration(Math.max(span, 0)),
                points: number(limits.maxDataPoints),
                spread: formatDuration(spread),
              },
            )}
          </span>
        </output>
        <PanelExtras
          panel={panel}
          parts={["time"]}
          bare
          onChange={onChange}
          rows={[]}
          variables={[]}
        />
        <TextField
          label={t("dashboards.queryOptions.cache.label")}
          hint={t("dashboards.queryOptions.cache.hint")}
          value={panel.cacheTimeout ?? ""}
          placeholder={t("dashboards.queryOptions.cache.placeholder")}
          mono
          autoComplete="off"
          error={
            panel.cacheTimeout !== undefined && !isCacheTimeout(panel.cacheTimeout)
              ? t("dashboards.queryOptions.cache.invalid")
              : undefined
          }
          onValueChange={(text) => onChange((p) => withOption(p, "cacheTimeout", text.trim()))}
        />
        <label className="checkbox" htmlFor={`${id}-hide`}>
          <input
            id={`${id}-hide`}
            type="checkbox"
            checked={panel.hideTimeNote === true}
            aria-describedby={`${id}-hide-hint`}
            onChange={(event) => {
              const hide = event.currentTarget.checked;
              onChange((p) => withOption(p, "hideTimeNote", hide));
            }}
          />
          {t("dashboards.queryOptions.hideNote.label")}
        </label>
        <p className="field__hint" id={`${id}-hide-hint`}>
          {t("dashboards.queryOptions.hideNote.hint")}
        </p>
      </div>
    </section>
  );
}
