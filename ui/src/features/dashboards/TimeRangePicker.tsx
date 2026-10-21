import { useId, useState } from "react";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import {
  isRelative,
  PRESETS,
  type Preset,
  presetOf,
  resolveRange,
  resolveTime,
  type TextRange,
  toStoredAbsolute,
} from "./timeRange";
import { Dialog } from "./ui/Dialog";

const PRESET_LABELS: Record<string, MessageKey> = {
  "now-5m|now": "dashboards.time.last5m",
  "now-15m|now": "dashboards.time.last15m",
  "now-1h|now": "dashboards.time.last1h",
  "now-6h|now": "dashboards.time.last6h",
  "now-12h|now": "dashboards.time.last12h",
  "now-24h|now": "dashboards.time.last24h",
  "now-2d|now": "dashboards.time.last2d",
  "now-7d|now": "dashboards.time.last7d",
  "now-30d|now": "dashboards.time.last30d",
  "now-90d|now": "dashboards.time.last90d",
  "now-1y|now": "dashboards.time.last1y",
  "now/d|now/d": "dashboards.time.today",
  "now-1d/d|now-1d/d": "dashboards.time.yesterday",
  "now/w|now/w": "dashboards.time.thisWeek",
  "now/M|now/M": "dashboards.time.thisMonth",
};

function presetLabel(t: Translate, preset: Preset): string {
  const key = PRESET_LABELS[`${preset.from}|${preset.to}`];
  return key === undefined ? `${preset.from} – ${preset.to}` : t(key);
}

/** One end as the user reads it: relative text as typed, absolute times in local format. */
function endLabel(text: string, language: string): string {
  if (isRelative(text)) {
    return text;
  }
  const time = resolveTime(text, Date.now());
  return time === null
    ? text
    : new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "short" }).format(time);
}

export function rangeLabel(t: Translate, language: string, range: TextRange): string {
  const preset = presetOf(range);
  if (preset !== undefined) {
    return presetLabel(t, preset);
  }
  return `${endLabel(range.from, language)} – ${endLabel(range.to, language)}`;
}

/** "2026-10-20 08:00" is accepted like the ISO form with a T. */
function normalize(text: string): string {
  return text.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2");
}

/** Absolute input is stored as an ISO time in UTC; relative text is stored as typed. */
function toStored(text: string): string {
  const value = normalize(text);
  if (isRelative(value)) {
    return value;
  }
  const time = resolveTime(value, Date.now());
  return time === null ? value : toStoredAbsolute(time);
}

interface TimeRangePickerProps {
  value: TextRange;
  onChange: (range: TextRange) => void;
}

/** The time range button and its dialog: quick choices, or from and to as text. */
export function TimeRangePicker({ value, onChange }: TimeRangePickerProps) {
  const { t, language } = useI18n();
  const [open, setOpen] = useState(false);
  const label = rangeLabel(t, language, value);
  return (
    <>
      <button
        type="button"
        className="button button--secondary"
        onClick={() => setOpen(true)}
        aria-label={t("dashboards.time.buttonLabel", { range: label })}
      >
        {label}
      </button>
      {open ? (
        <RangeDialog
          value={value}
          onClose={() => setOpen(false)}
          onApply={(range) => {
            setOpen(false);
            onChange(range);
          }}
        />
      ) : null}
    </>
  );
}

function RangeDialog({
  value,
  onClose,
  onApply,
}: {
  value: TextRange;
  onClose: () => void;
  onApply: (range: TextRange) => void;
}) {
  const { t, language } = useI18n();
  const fromId = useId();
  const toId = useId();
  const hintId = useId();
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [submitted, setSubmitted] = useState(false);
  const current = presetOf(value);
  const resolved = resolveRange({ from: normalize(from), to: normalize(to) }, Date.now());
  const format = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "medium" });
  const problem = resolved.ok ? undefined : t(`dashboards.time.error.${resolved.error}`);

  return (
    <Dialog title={t("dashboards.time.title")} onClose={onClose} size="small">
      <div className="time-dialog">
        <ul className="time-dialog__presets" aria-label={t("dashboards.time.presets")}>
          {PRESETS.map((preset) => (
            <li key={`${preset.from}|${preset.to}`}>
              <button
                type="button"
                className="time-dialog__preset"
                aria-pressed={preset === current}
                onClick={() => onApply({ from: preset.from, to: preset.to })}
              >
                {presetLabel(t, preset)}
              </button>
            </li>
          ))}
        </ul>
        <form
          className="form time-dialog__custom"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if (resolved.ok) {
              onApply({ from: toStored(from), to: toStored(to) });
            }
          }}
        >
          <p className="field__hint" id={hintId}>
            {t("dashboards.time.hint")}
          </p>
          <div className="field">
            <label className="field__label" htmlFor={fromId}>
              {t("dashboards.time.from")}
            </label>
            <input
              id={fromId}
              className="input input--mono"
              value={from}
              onChange={(event) => setFrom(event.currentTarget.value)}
              aria-describedby={hintId}
              aria-invalid={
                submitted && !resolved.ok && resolved.error !== "invalidTo" ? true : undefined
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={toId}>
              {t("dashboards.time.to")}
            </label>
            <input
              id={toId}
              className="input input--mono"
              value={to}
              onChange={(event) => setTo(event.currentTarget.value)}
              aria-describedby={hintId}
              aria-invalid={
                submitted && !resolved.ok && resolved.error === "invalidTo" ? true : undefined
              }
              spellCheck={false}
              autoComplete="off"
            />
          </div>
          <p className="time-dialog__resolved" role="status">
            {resolved.ok
              ? t("dashboards.time.resolved", {
                  from: format.format(resolved.range.from),
                  to: format.format(resolved.range.to),
                })
              : submitted
                ? problem
                : ""}
          </p>
          <div className="form__actions">
            <button type="submit" className="button button--primary">
              {t("dashboards.time.apply")}
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
