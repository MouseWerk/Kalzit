import {
  type KeyboardEvent,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { IconButton, WithTooltip } from "../../components/IconButton";
import { type Translate, useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import {
  getTimeSettings,
  type TimeSettings,
  useTimeSettings,
  zoneOption,
} from "../../lib/timeSettings";
import { showErrorToast, showToast } from "../../lib/toasts";
import { wallOf } from "../../lib/zonedTime";
import { Calendar, type Day, dayText } from "./Calendar";
import { readRecentRanges, rememberRange } from "./recentRanges";
import {
  isRelative,
  PRESETS,
  type Preset,
  presetOf,
  rangeFromClipboard,
  rangeToClipboard,
  resolveRange,
  resolveTime,
  shiftRange,
  type TextRange,
  toStoredAbsolute,
  zoomOutRange,
} from "./timeRange";
import { type TimeShortcut, useTimeShortcuts } from "./timeShortcuts";
import "./dashboards.css";
import "./toolbar.css";

function presetLabel(t: Translate, preset: Preset): string {
  return t(preset.label);
}

/** One end as the user reads it: relative text as typed, absolute times in local format. */
function endLabel(text: string, language: string, zone: string | null): string {
  if (isRelative(text)) {
    return text;
  }
  const time = resolveTime(text, Date.now(), false, { ...getTimeSettings(), timeZone: zone });
  return time === null
    ? text
    : new Intl.DateTimeFormat(language, {
        dateStyle: "short",
        timeStyle: "short",
        ...zoneOption(zone),
      }).format(time);
}

export function rangeLabel(
  t: Translate,
  language: string,
  range: TextRange,
  zone: string | null,
): string {
  const preset = presetOf(range);
  if (preset !== undefined) {
    return presetLabel(t, preset);
  }
  return `${endLabel(range.from, language, zone)} – ${endLabel(range.to, language, zone)}`;
}

/** "2026-10-20 08:00" is accepted like the ISO form with a T. */
function normalize(text: string): string {
  return text.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d)/, "$1T$2");
}

/** Absolute input is stored as an ISO time in UTC; relative text is stored as typed. */
function toStored(text: string, settings: TimeSettings): string {
  const value = normalize(text);
  if (isRelative(value)) {
    return value;
  }
  const time = resolveTime(value, Date.now(), false, settings);
  return time === null ? value : toStoredAbsolute(time);
}

/** The zone's offset from UTC now, as the browser writes it: "GMT+2". */
function zoneOffset(language: string, zone: string | null): string {
  return (
    new Intl.DateTimeFormat(language, { timeZoneName: "shortOffset", ...zoneOption(zone) })
      .formatToParts(Date.now())
      .find((part) => part.type === "timeZoneName")?.value ?? ""
  );
}

/** The zone's name and offset, as the picker's footer shows it: "Europe/Berlin, GMT+2". */
function zoneText(language: string, zone: string | null): string {
  const name = zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = zoneOffset(language, zone);
  return offset === "" ? name : `${name}, ${offset}`;
}

interface TimeRangePickerProps {
  value: TextRange;
  onChange: (range: TextRange) => void;
  /** What the range is for, in the button's accessible name ("Default time range: ..."). */
  name?: string;
  /** The signed-in account: the ranges it applied are offered again (kept in this browser). */
  userId?: string | undefined;
  /** Whether the zone in effect is the dashboard's own (named in the footer). */
  dashboardZone?: boolean;
  /** Shows the zone's offset in the button, after the range. */
  showZone?: boolean;
}

/**
 * The time range button and its popover: quick ranges with a search, recently used ranges,
 * an absolute range typed or picked on a calendar, copy and paste. The popover is not modal:
 * Escape, a click outside or leaving it with Tab closes it.
 */
export function TimeRangePicker({
  value,
  onChange,
  name,
  userId,
  dashboardZone = false,
  showZone = false,
}: TimeRangePickerProps) {
  const { t, language, timeZone } = useI18n();
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverId = useId();
  const label = rangeLabel(t, language, value, timeZone);
  const zone = showZone ? zoneOffset(language, timeZone) : "";
  // The name holds what the button shows, the zone included.
  const shown = zone === "" ? label : `${label} ${zone}`;
  const accessible =
    name === undefined
      ? t("dashboards.time.buttonLabel", { range: shown })
      : t("dashboards.time.buttonFor", { name, range: label });
  return (
    <>
      <WithTooltip label={t("dashboards.time.title")}>
        <button
          ref={buttonRef}
          type="button"
          className="button button--ghost time-picker__button"
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? popoverId : undefined}
          aria-label={accessible}
          onClick={() => setOpen((o) => !o)}
        >
          <Icon name="clock" />
          <span className="time-picker__label truncate">{label}</span>
          {/* A space, so the text reads as the name does: "Last 6 hours GMT+2". */}
          {zone === "" ? null : " "}
          {zone === "" ? null : <span className="time-picker__zone-tag">{zone}</span>}
          <Icon name="chevronDown" className="time-picker__chevron" />
        </button>
      </WithTooltip>
      {open ? (
        <RangePopover
          id={popoverId}
          anchor={buttonRef}
          value={value}
          userId={userId}
          dashboardZone={dashboardZone}
          onClose={(returnFocus) => {
            setOpen(false);
            if (returnFocus) {
              buttonRef.current?.focus();
            }
          }}
          onApply={(range) => {
            setOpen(false);
            buttonRef.current?.focus();
            if (userId !== undefined) {
              rememberRange(userId, range);
            }
            onChange(range);
          }}
        />
      ) : null}
    </>
  );
}

function RangePopover({
  id,
  anchor,
  value,
  userId,
  dashboardZone,
  onClose,
  onApply,
}: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  value: TextRange;
  userId: string | undefined;
  dashboardZone: boolean;
  onClose: (returnFocus: boolean) => void;
  onApply: (range: TextRange) => void;
}) {
  const { t, language } = useI18n();
  const settings = useTimeSettings();
  const ref = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const fromId = useId();
  const toId = useId();
  const hintId = useId();
  const searchId = useId();
  const [from, setFrom] = useState(value.from);
  const [to, setTo] = useState(value.to);
  const [submitted, setSubmitted] = useState(false);
  const [query, setQuery] = useState("");
  // Which end the calendar picks: open for the start, then for the end.
  const [calendar, setCalendar] = useState<"from" | "to" | null>(null);
  const [recent] = useState(() => (userId === undefined ? [] : readRecentRanges(userId)));
  const current = presetOf(value);
  const now = Date.now();
  const resolved = resolveRange({ from: normalize(from), to: normalize(to) }, now, settings);
  const format = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "medium",
    ...zoneOption(settings.timeZone),
  });
  const problem = resolved.ok ? undefined : t(`dashboards.time.error.${resolved.error}`);
  const fiscal = settings.fiscalYearStartMonth !== undefined;
  const needle = query.trim().toLowerCase();
  const presets = PRESETS.filter((preset) => fiscal || preset.fiscal !== true).filter(
    (preset) =>
      needle === "" ||
      presetLabel(t, preset).toLowerCase().includes(needle) ||
      `${preset.from} ${preset.to}`.toLowerCase().includes(needle),
  );

  useEscapeLayer(true, () => onClose(true));

  // Under the button, its right edge on the button's; on a phone across the width.
  useLayoutEffect(() => {
    const button = anchor.current;
    const popover = ref.current;
    if (button === null || popover === null) {
      return;
    }
    const box = button.getBoundingClientRect();
    popover.style.setProperty("--popover-top", `${box.bottom}px`);
    popover.style.setProperty("--popover-right", `${Math.max(window.innerWidth - box.right, 0)}px`);
  }, [anchor]);

  useLayoutEffect(() => {
    searchRef.current?.focus();
  }, []);

  // A click outside closes it without pulling focus back; so does a resize.
  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target;
      if (
        target instanceof Node &&
        ref.current?.contains(target) !== true &&
        anchor.current?.contains(target) !== true
      ) {
        onClose(false);
      }
    }
    const onResize = () => onClose(false);
    document.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("resize", onResize);
    };
  }, [anchor, onClose]);

  // Tab past the last control (or before the first) leaves the popover and closes it.
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab") {
      return;
    }
    const items = Array.from(
      ref.current?.querySelectorAll<HTMLElement>(
        'button:not([disabled]):not([tabindex="-1"]), input, [tabindex="0"]',
      ) ?? [],
    );
    const edge = event.shiftKey ? items[0] : items.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      onClose(true);
    }
  }

  function applyTyped() {
    setSubmitted(true);
    if (resolved.ok) {
      onApply({ from: toStored(from, settings), to: toStored(to, settings) });
    }
  }

  function pick(day: Day) {
    // The start is the day's midnight, the end its last second, as typed text.
    if (calendar === "to") {
      setTo(`${dayText(day)} 23:59:59`);
      setCalendar(null);
    } else {
      setFrom(`${dayText(day)} 00:00:00`);
      setCalendar("to");
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(rangeToClipboard(value));
      showToast({ message: t("toolbar.time.copied") });
    } catch {
      showErrorToast(t("toolbar.time.copyFailed"));
    }
  }

  async function paste() {
    let text = "";
    try {
      text = await navigator.clipboard.readText();
    } catch {
      showErrorToast(t("toolbar.time.pasteFailed"));
      return;
    }
    const range = rangeFromClipboard(text, Date.now());
    if (range === null) {
      showErrorToast(t("toolbar.time.pasteInvalid"));
      return;
    }
    onApply(range);
  }

  const today = wallOf(now, settings.timeZone);
  const fromTime = resolveTime(normalize(from), now, false, settings);
  const toTime = resolveTime(normalize(to), now, true, settings);
  const dayOf = (ms: number | null): Day | null => {
    if (ms === null) return null;
    const w = wallOf(ms, settings.timeZone);
    return { year: w.year, month: w.month, day: w.day };
  };
  const firstDay = settings.weekStart === "sunday" ? 0 : settings.weekStart === "saturday" ? 6 : 1;

  return createPortal(
    <div
      ref={ref}
      id={id}
      className="time-picker"
      role="dialog"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
    >
      <h2 className="visually-hidden" id={titleId}>
        {t("dashboards.time.title")}
      </h2>
      <div className="time-picker__body">
        <section className="time-picker__quick" aria-label={t("dashboards.time.presets")}>
          <label className="visually-hidden" htmlFor={searchId}>
            {t("toolbar.time.search")}
          </label>
          <div className="time-picker__search">
            <Icon name="search" />
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              className="input"
              placeholder={t("toolbar.time.search")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              onKeyDown={(event) => {
                // Enter takes the first match.
                const first = presets[0];
                if (event.key === "Enter" && first !== undefined) {
                  event.preventDefault();
                  onApply({ from: first.from, to: first.to });
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          {presets.length === 0 ? (
            <p className="time-picker__empty" role="status">
              {t("toolbar.time.noMatch")}
            </p>
          ) : (
            <ul className="time-picker__presets">
              {presets.map((preset) => (
                <li key={`${preset.from}|${preset.to}`}>
                  <button
                    type="button"
                    className="time-picker__preset"
                    aria-pressed={preset === current}
                    onClick={() => onApply({ from: preset.from, to: preset.to })}
                  >
                    {presetLabel(t, preset)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
        <section className="time-picker__absolute" aria-labelledby={`${titleId}-absolute`}>
          <h3 className="time-picker__heading" id={`${titleId}-absolute`}>
            {t("toolbar.time.absolute")}
          </h3>
          <form
            className="form time-picker__form"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              applyTyped();
            }}
          >
            <p className="field__hint" id={hintId}>
              {t("dashboards.time.hint")}
            </p>
            <div className="field">
              <label className="field__label" htmlFor={fromId}>
                {t("dashboards.time.from")}
              </label>
              <div className="time-picker__end">
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
                <IconButton
                  icon="calendar"
                  label={t("toolbar.calendar.pickStart")}
                  aria-pressed={calendar === "from"}
                  onClick={() => setCalendar((c) => (c === "from" ? null : "from"))}
                />
              </div>
            </div>
            <div className="field">
              <label className="field__label" htmlFor={toId}>
                {t("dashboards.time.to")}
              </label>
              <div className="time-picker__end">
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
                <IconButton
                  icon="calendar"
                  label={t("toolbar.calendar.pickEnd")}
                  aria-pressed={calendar === "to"}
                  onClick={() => setCalendar((c) => (c === "to" ? null : "to"))}
                />
              </div>
            </div>
            {calendar === null ? null : (
              <Calendar
                key={calendar}
                start={dayOf(fromTime)}
                end={dayOf(toTime)}
                today={{ year: today.year, month: today.month, day: today.day }}
                firstDay={firstDay}
                label={
                  calendar === "from"
                    ? t("toolbar.calendar.pickStart")
                    : t("toolbar.calendar.pickEnd")
                }
                onPick={pick}
              />
            )}
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
            <div className="time-picker__actions">
              <button type="submit" className="button button--primary">
                {t("dashboards.time.apply")}
              </button>
              <IconButton
                icon="copy"
                label={t("toolbar.time.copy")}
                shortcut={["t", "c"]}
                onClick={() => void copy()}
              />
              <IconButton
                icon="paste"
                label={t("toolbar.time.paste")}
                shortcut={["t", "v"]}
                onClick={() => void paste()}
              />
            </div>
          </form>
          {recent.length === 0 ? null : (
            <div className="time-picker__recent">
              <h3 className="time-picker__heading" id={`${titleId}-recent`}>
                {t("toolbar.time.recent")}
              </h3>
              <ul className="time-picker__presets" aria-labelledby={`${titleId}-recent`}>
                {recent.map((range) => (
                  <li key={`${range.from}|${range.to}`}>
                    <button
                      type="button"
                      className="time-picker__preset"
                      onClick={() => onApply(range)}
                    >
                      {rangeLabel(t, language, range, settings.timeZone)}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>
      </div>
      <p className="time-picker__zone">
        {t(dashboardZone ? "toolbar.time.zoneDashboard" : "toolbar.time.zone", {
          zone: zoneText(language, settings.timeZone),
        })}
      </p>
    </div>,
    document.body,
  );
}

interface TimeControlsProps {
  value: TextRange;
  onChange: (range: TextRange) => void;
  userId?: string | undefined;
  dashboardZone?: boolean;
  /** Listen for the time shortcuts (t and Left, Right, z, c, v). */
  shortcuts?: boolean;
  /** Only the range button (the panel editor's bar); the shortcuts still work. */
  compact?: boolean;
}

/**
 * The time range with its neighbors: move back, the picker, move forward, zoom out. The same
 * controls in the dashboard toolbar and in the panel editor's bar.
 */
export function TimeControls({
  value,
  onChange,
  userId,
  dashboardZone = false,
  shortcuts = false,
  compact = false,
}: TimeControlsProps) {
  const { t } = useI18n();
  const settings = useTimeSettings();

  function apply(next: TextRange | null) {
    if (next !== null) {
      onChange(next);
    }
  }

  function run(shortcut: TimeShortcut) {
    switch (shortcut) {
      case "back":
        apply(shiftRange(value, -1, Date.now(), settings));
        break;
      case "forward":
        apply(shiftRange(value, 1, Date.now(), settings));
        break;
      case "zoomOut":
        apply(zoomOutRange(value, Date.now(), settings));
        break;
      case "copy":
        navigator.clipboard.writeText(rangeToClipboard(value)).then(
          () => showToast({ message: t("toolbar.time.copied") }),
          () => showErrorToast(t("toolbar.time.copyFailed")),
        );
        break;
      case "paste":
        navigator.clipboard.readText().then(
          (text) => {
            const range = rangeFromClipboard(text, Date.now());
            if (range === null) {
              showErrorToast(t("toolbar.time.pasteInvalid"));
            } else {
              onChange(range);
            }
          },
          () => showErrorToast(t("toolbar.time.pasteFailed")),
        );
        break;
    }
  }
  useTimeShortcuts(shortcuts, run);

  if (compact) {
    return (
      <TimeRangePicker
        value={value}
        onChange={onChange}
        userId={userId}
        dashboardZone={dashboardZone}
      />
    );
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a set of form fields
    <div className="time-controls" role="group" aria-label={t("toolbar.time.controls")}>
      <IconButton
        icon="chevronLeft"
        label={t("toolbar.time.back")}
        shortcut={["t", "←"]}
        ariaShortcut="t ArrowLeft"
        className="time-controls__step"
        onClick={() => run("back")}
      />
      <TimeRangePicker
        value={value}
        onChange={onChange}
        userId={userId}
        dashboardZone={dashboardZone}
        showZone
      />
      <IconButton
        icon="chevron"
        label={t("toolbar.time.forward")}
        shortcut={["t", "→"]}
        ariaShortcut="t ArrowRight"
        className="time-controls__step"
        onClick={() => run("forward")}
      />
      <IconButton
        icon="zoomOut"
        label={t("toolbar.time.zoomOut")}
        shortcut={["t", "z"]}
        ariaShortcut="t z"
        onClick={() => run("zoomOut")}
      />
    </div>
  );
}
