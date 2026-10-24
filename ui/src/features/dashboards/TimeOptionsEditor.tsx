import { useId } from "react";
import { TextField } from "../../components/TextField";
import { type Translate, useI18n } from "../../i18n/i18n";
import { browserZone, timeZones, WEEK_STARTS, type WeekStart } from "../../lib/timeSettings";
import { BROWSER_ZONE, type DashboardModel, SHARED_CURSORS, type SharedCursor } from "./model";
import {
  formatDurationList,
  MAX_REFRESH_INTERVALS,
  MAX_REFRESH_SECONDS,
  MIN_REFRESH_SECONDS,
} from "./refresh";
import { parseDuration } from "./timeRange";
import "./ui/shared.css";
import "./toolbar.css";

/** The time options as the settings dialog edits them: text and choices, checked on apply. */
export interface TimeOptionsDraft {
  /** "" leaves the zone to each viewer; "browser" or an IANA name. */
  timeZone: string;
  weekStart: WeekStart | "";
  /** "" is January (the calendar year); "1" to "12". */
  fiscalMonth: string;
  nowDelay: string;
  /** "10s, 1m, 5m"; empty for Kalzit's list. */
  intervals: string;
  sharedCursor: SharedCursor;
}

export function timeOptionsDraft(model: DashboardModel): TimeOptionsDraft {
  return {
    timeZone: model.timeZone ?? "",
    weekStart: model.weekStart ?? "",
    fiscalMonth: model.fiscalYearStartMonth === undefined ? "" : String(model.fiscalYearStartMonth),
    nowDelay: model.nowDelay ?? "",
    intervals: formatDurationList(model.refreshIntervals ?? []),
    sharedCursor: model.sharedCursor ?? "off",
  };
}

export type TimeOptionsProblems = Partial<Record<"nowDelay" | "intervals", string>>;

/** The interval list in seconds, ascending and without repeats, or what is wrong with it. */
export function parseIntervals(
  t: Translate,
  text: string,
): { ok: true; seconds: number[] } | { ok: false; error: string } {
  const parts = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");
  const seconds: number[] = [];
  for (const part of parts) {
    const value = parseDuration(part);
    if (value === null || value < MIN_REFRESH_SECONDS || value > MAX_REFRESH_SECONDS) {
      return { ok: false, error: t("toolbar.settings.intervalsInvalid", { value: part }) };
    }
    if (!seconds.includes(value)) {
      seconds.push(value);
    }
  }
  if (seconds.length > MAX_REFRESH_INTERVALS) {
    return {
      ok: false,
      error: t("toolbar.settings.intervalsTooMany", { max: MAX_REFRESH_INTERVALS }),
    };
  }
  return { ok: true, seconds: seconds.sort((a, b) => a - b) };
}

/** What is wrong with the draft, per field; empty when it can be applied. */
export function timeOptionsProblems(t: Translate, draft: TimeOptionsDraft): TimeOptionsProblems {
  const problems: TimeOptionsProblems = {};
  const delay = draft.nowDelay.trim();
  if (delay !== "" && parseDuration(delay) === null) {
    problems.nowDelay = t("toolbar.settings.nowDelayInvalid");
  }
  const intervals = parseIntervals(t, draft.intervals);
  if (!intervals.ok) {
    problems.intervals = intervals.error;
  }
  return problems;
}

/** The draft written into the model: unset options are left out, as the server stores them. */
export function applyTimeOptions(
  t: Translate,
  model: DashboardModel,
  draft: TimeOptionsDraft,
): DashboardModel {
  const next = { ...model };
  delete next.timeZone;
  delete next.weekStart;
  delete next.fiscalYearStartMonth;
  delete next.nowDelay;
  delete next.refreshIntervals;
  delete next.sharedCursor;
  if (draft.timeZone !== "") next.timeZone = draft.timeZone;
  if (draft.weekStart !== "") next.weekStart = draft.weekStart;
  if (draft.fiscalMonth !== "" && draft.fiscalMonth !== "1") {
    next.fiscalYearStartMonth = Number(draft.fiscalMonth);
  }
  const delay = draft.nowDelay.trim();
  if (delay !== "") next.nowDelay = delay;
  const intervals = parseIntervals(t, draft.intervals);
  if (intervals.ok && intervals.seconds.length > 0) next.refreshIntervals = intervals.seconds;
  if (draft.sharedCursor !== "off") next.sharedCursor = draft.sharedCursor;
  return next;
}

interface TimeOptionsEditorProps {
  draft: TimeOptionsDraft;
  onChange: (patch: Partial<TimeOptionsDraft>) => void;
  problems: TimeOptionsProblems;
}

/** The dashboard's time options in its settings: zone, week, fiscal year, now delay, refresh. */
export function TimeOptionsEditor({ draft, onChange, problems }: TimeOptionsEditorProps) {
  const { t, language } = useI18n();
  const id = useId();
  const zones = timeZones();
  const months = Array.from({ length: 12 }, (_, i) => ({
    value: String(i + 1),
    label: new Intl.DateTimeFormat(language, { month: "long", timeZone: "UTC" }).format(
      new Date(Date.UTC(2026, i, 15)),
    ),
  }));
  return (
    <fieldset className="settings__time">
      <legend className="section-title">{t("toolbar.settings.time")}</legend>
      <div className="settings__time-grid">
        <div className="field">
          <label className="field__label" htmlFor={`${id}-zone`}>
            {t("toolbar.settings.timeZone")}
          </label>
          <select
            id={`${id}-zone`}
            className="select"
            value={draft.timeZone}
            onChange={(event) => onChange({ timeZone: event.currentTarget.value })}
          >
            <option value="">{t("toolbar.settings.timeZoneViewer")}</option>
            <option value={BROWSER_ZONE}>
              {t("toolbar.settings.timeZoneBrowser", { zone: browserZone() })}
            </option>
            {draft.timeZone !== "" &&
            draft.timeZone !== BROWSER_ZONE &&
            !zones.includes(draft.timeZone) ? (
              <option value={draft.timeZone}>{draft.timeZone}</option>
            ) : null}
            {zones.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-week`}>
            {t("shell.preferences.weekStart")}
          </label>
          <select
            id={`${id}-week`}
            className="select"
            value={draft.weekStart}
            onChange={(event) =>
              onChange({ weekStart: event.currentTarget.value as WeekStart | "" })
            }
          >
            <option value="">{t("toolbar.settings.weekStartViewer")}</option>
            {WEEK_STARTS.map((start) => (
              <option key={start} value={start}>
                {t(`shell.preferences.week.${start}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-fiscal`}>
            {t("toolbar.settings.fiscalYear")}
          </label>
          <select
            id={`${id}-fiscal`}
            className="select"
            value={draft.fiscalMonth === "" ? "1" : draft.fiscalMonth}
            onChange={(event) => onChange({ fiscalMonth: event.currentTarget.value })}
            aria-describedby={`${id}-fiscal-hint`}
          >
            {months.map((month) => (
              <option key={month.value} value={month.value}>
                {month.label}
              </option>
            ))}
          </select>
          <p className="field__hint" id={`${id}-fiscal-hint`}>
            {t("toolbar.settings.fiscalYearHint")}
          </p>
        </div>
        <TextField
          label={t("toolbar.settings.nowDelay")}
          hint={t("toolbar.settings.nowDelayHint")}
          value={draft.nowDelay}
          onValueChange={(nowDelay) => onChange({ nowDelay })}
          error={problems.nowDelay}
          mono
          autoComplete="off"
        />
        <TextField
          label={t("toolbar.settings.intervals")}
          hint={t("toolbar.settings.intervalsHint")}
          value={draft.intervals}
          onValueChange={(intervals) => onChange({ intervals })}
          error={problems.intervals}
          mono
          autoComplete="off"
        />
        <div className="field">
          <label className="field__label" htmlFor={`${id}-cursor`}>
            {t("toolbar.settings.sharedCursor")}
          </label>
          <select
            id={`${id}-cursor`}
            className="select"
            value={draft.sharedCursor}
            onChange={(event) =>
              onChange({ sharedCursor: event.currentTarget.value as SharedCursor })
            }
            aria-describedby={`${id}-cursor-hint`}
          >
            {SHARED_CURSORS.map((mode) => (
              <option key={mode} value={mode}>
                {t(`toolbar.settings.sharedCursor.${mode}`)}
              </option>
            ))}
          </select>
          <p className="field__hint" id={`${id}-cursor-hint`}>
            {t("toolbar.settings.sharedCursorHint")}
          </p>
        </div>
      </div>
    </fieldset>
  );
}
