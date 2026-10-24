import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { normalizeWall, weekdayOf } from "../../lib/zonedTime";
import "../../components/iconButton.css";
import "./toolbar.css";

/** A calendar day, without a time or a zone. */
export interface Day {
  year: number;
  /** 1 to 12. */
  month: number;
  day: number;
}

const MIDNIGHT = { hour: 0, minute: 0, second: 0, millisecond: 0 };

function normal(day: Day): Day {
  const w = normalizeWall({ ...day, ...MIDNIGHT });
  return { year: w.year, month: w.month, day: w.day };
}

function sameDay(a: Day | null, b: Day | null): boolean {
  return a !== null && b !== null && a.year === b.year && a.month === b.month && a.day === b.day;
}

function order(day: Day): number {
  return day.year * 10_000 + day.month * 100 + day.day;
}

/** "2026-10-20", as the range inputs take it. */
export function dayText(day: Day): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${day.year}-${pad(day.month)}-${pad(day.day)}`;
}

interface CalendarProps {
  /** The days the range starts and ends on, or null. */
  start: Day | null;
  end: Day | null;
  /** Today in the zone in effect, marked in the grid. */
  today: Day;
  /** 0 for Sunday to 6 for Saturday. */
  firstDay: number;
  onPick: (day: Day) => void;
  /** Names the grid ("Pick the start day"). */
  label: string;
}

/**
 * A month of days to pick a range's start or end from. Arrow keys move by a day or a week,
 * Page Up and Page Down by a month, Home and End to the week's ends; only the focused day is in
 * the tab order. The chosen days are a quiet tint and bold, the days between a lighter tint.
 */
export function Calendar({ start, end, today, firstDay, onPick, label }: CalendarProps) {
  const { t, language } = useI18n();
  const [focus, setFocus] = useState<Day>(() => start ?? today);
  const [shown, setShown] = useState<{ year: number; month: number }>(() => ({
    year: (start ?? today).year,
    month: (start ?? today).month,
  }));
  const gridRef = useRef<HTMLTableElement>(null);
  const moved = useRef(false);

  useEffect(() => {
    if (!moved.current) {
      return;
    }
    moved.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>('button[tabindex="0"]')?.focus();
  });

  const first = { year: shown.year, month: shown.month, day: 1 };
  const lead = (weekdayOf({ ...first, ...MIDNIGHT }) - firstDay + 7) % 7;
  const days = normal({ year: shown.year, month: shown.month + 1, day: 0 }).day;
  const cells: (Day | null)[] = [
    ...Array.from({ length: lead }, () => null),
    ...Array.from({ length: days }, (_, i) => ({ ...first, day: i + 1 })),
  ];
  while (cells.length % 7 !== 0) {
    cells.push(null);
  }
  const weeks = Array.from({ length: cells.length / 7 }, (_, i) => cells.slice(i * 7, i * 7 + 7));
  const utc = (day: Day) => new Date(Date.UTC(day.year, day.month - 1, day.day, 12));
  const weekdayNames = Array.from({ length: 7 }, (_, i) => {
    // 2023-01-01 was a Sunday.
    const date = new Date(Date.UTC(2023, 0, 1 + ((firstDay + i) % 7), 12));
    return {
      short: new Intl.DateTimeFormat(language, { weekday: "narrow", timeZone: "UTC" }).format(date),
      long: new Intl.DateTimeFormat(language, { weekday: "long", timeZone: "UTC" }).format(date),
    };
  });
  const monthName = new Intl.DateTimeFormat(language, {
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  }).format(utc(first));
  const dayName = new Intl.DateTimeFormat(language, { dateStyle: "full", timeZone: "UTC" });
  const low = start !== null && end !== null && order(end) < order(start) ? end : start;
  const high = start !== null && end !== null && order(end) < order(start) ? start : end;

  function moveTo(day: Day) {
    const next = normal(day);
    setFocus(next);
    setShown({ year: next.year, month: next.month });
    moved.current = true;
  }

  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    const weekday = (weekdayOf({ ...focus, ...MIDNIGHT }) - firstDay + 7) % 7;
    const steps: Record<string, Day> = {
      ArrowLeft: { ...focus, day: focus.day - 1 },
      ArrowRight: { ...focus, day: focus.day + 1 },
      ArrowUp: { ...focus, day: focus.day - 7 },
      ArrowDown: { ...focus, day: focus.day + 7 },
      PageUp: { ...focus, month: focus.month - 1 },
      PageDown: { ...focus, month: focus.month + 1 },
      Home: { ...focus, day: focus.day - weekday },
      End: { ...focus, day: focus.day + (6 - weekday) },
    };
    const next = steps[event.key];
    if (next !== undefined) {
      event.preventDefault();
      // A month step keeps the day, clamped to the shorter month.
      if (event.key === "PageUp" || event.key === "PageDown") {
        const target = normal({ ...next, day: 1 });
        const last = normal({ ...target, month: target.month + 1, day: 0 }).day;
        moveTo({ ...target, day: Math.min(focus.day, last) });
        return;
      }
      moveTo(next);
    }
  }

  // The focused day is in the tab order; when it is not in the month shown, the first day is.
  const focusShown = focus.year === shown.year && focus.month === shown.month;
  const tabbable = focusShown ? focus : first;

  return (
    <div className="calendar">
      <div className="calendar__head">
        <button
          type="button"
          className="button button--ghost icon-button"
          aria-label={t("toolbar.calendar.previousMonth")}
          title={t("toolbar.calendar.previousMonth")}
          onClick={() => setShown((s) => normalMonth(s, -1))}
        >
          <Icon name="chevronLeft" />
        </button>
        <span className="calendar__month" aria-live="polite">
          {monthName}
        </span>
        <button
          type="button"
          className="button button--ghost icon-button"
          aria-label={t("toolbar.calendar.nextMonth")}
          title={t("toolbar.calendar.nextMonth")}
          onClick={() => setShown((s) => normalMonth(s, 1))}
        >
          <Icon name="chevron" />
        </button>
      </div>
      <table
        className="calendar__grid"
        aria-label={`${label}, ${monthName}`}
        ref={gridRef}
        onKeyDown={onKeyDown}
      >
        <thead>
          <tr>
            {weekdayNames.map((name) => (
              <th key={name.long} scope="col" abbr={name.long} className="calendar__weekday">
                {name.short}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.find((d) => d !== null)?.day ?? 0}>
              {week.map((day, index) => {
                if (day === null) {
                  // biome-ignore lint/suspicious/noArrayIndexKey: empty cells have only a place
                  return <td key={`empty-${index}`} />;
                }
                const chosen = sameDay(day, start) || sameDay(day, end);
                const between =
                  low !== null &&
                  high !== null &&
                  order(day) > order(low) &&
                  order(day) < order(high);
                const classes = [
                  "calendar__day",
                  chosen ? "calendar__day--chosen" : "",
                  between ? "calendar__day--between" : "",
                  sameDay(day, today) ? "calendar__day--today" : "",
                ]
                  .filter((c) => c !== "")
                  .join(" ");
                return (
                  <td key={day.day}>
                    <button
                      type="button"
                      className={classes}
                      tabIndex={sameDay(day, tabbable) ? 0 : -1}
                      aria-pressed={chosen}
                      aria-current={sameDay(day, today) ? "date" : undefined}
                      aria-label={dayName.format(utc(day))}
                      onClick={() => {
                        setFocus(day);
                        onPick(day);
                      }}
                    >
                      {day.day}
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function normalMonth(shown: { year: number; month: number }, by: number) {
  const next = normalizeWall({ year: shown.year, month: shown.month + by, day: 1, ...MIDNIGHT });
  return { year: next.year, month: next.month };
}
