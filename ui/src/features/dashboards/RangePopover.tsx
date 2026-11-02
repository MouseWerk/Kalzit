// The time picker's popover: quick ranges with a search, recently used ranges, an absolute range
// typed or picked on a calendar, copy and paste. Its own chunk, loaded when the picker first
// opens (TimeRangePicker.tsx), so a dashboard's toolbar loads only the button.
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
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useEscapeLayer } from "../../lib/layers";
import { type TimeSettings, useTimeSettings, zoneOption } from "../../lib/timeSettings";
import { wallOf } from "../../lib/zonedTime";
import { Calendar, type Day, dayText } from "./Calendar";
import { useRangeClipboard } from "./rangeClipboard";
import { presetLabel, rangeLabel, zoneOffset } from "./rangeLabel";
import { readRecentRanges } from "./recentRanges";
import {
  delayedNow,
  isRelative,
  PRESETS,
  presetOf,
  resolveRange,
  resolveTime,
  type TextRange,
  toStoredAbsolute,
} from "./timeRange";
import "./dashboards.css";
import "./toolbar.css";

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

/** The zone's name and offset, as the picker's footer shows it: "Europe/Berlin, GMT+2". */
function zoneText(language: string, zone: string | null): string {
  const name = zone ?? new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const offset = zoneOffset(language, zone);
  return offset === "" ? name : `${name}, ${offset}`;
}

export function RangePopover({
  id,
  anchor,
  value,
  userId,
  dashboardZone,
  nowDelay,
  onClose,
  onApply,
}: {
  id: string;
  anchor: RefObject<HTMLButtonElement | null>;
  value: TextRange;
  userId: string | undefined;
  dashboardZone: boolean;
  nowDelay: string | undefined;
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
  const clipboard = useRangeClipboard();
  // "Now" as the dashboard reads it, so the preview shows the range its queries will get.
  const now = delayedNow(Date.now(), nowDelay, settings);
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

  // The search takes focus, except on a touch screen, where it would open the soft keyboard over
  // the list the person came for.
  useLayoutEffect(() => {
    if (window.matchMedia?.("(pointer: coarse)").matches !== true) {
      searchRef.current?.focus();
    }
  }, []);

  // A click outside closes it without pulling focus back; so does a change of the window's width.
  // A change of its height alone (a phone's soft keyboard) leaves it open.
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
    let width = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth !== width) {
        width = window.innerWidth;
        onClose(false);
      }
    };
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
    await clipboard.copy(value);
  }

  // A pasted range is applied like a chosen one, so it joins the recent ranges too.
  async function paste() {
    const range = await clipboard.paste();
    if (range !== null) {
      onApply(range);
    }
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
                if (event.key === "Enter" && first !== undefined && !isComposingKey(event)) {
                  event.preventDefault();
                  onApply({ from: first.from, to: first.to });
                }
              }}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <div className="live-region" role="status">
            {presets.length === 0 ? (
              <p className="time-picker__empty">{t("toolbar.time.noMatch")}</p>
            ) : null}
          </div>
          {presets.length === 0 ? null : (
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
