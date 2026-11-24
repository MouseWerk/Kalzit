import { type MouseEvent, type PointerEvent, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { isMac } from "../shortcuts/platform";
import { shortcutText } from "../shortcuts/registry";
import { stepText } from "./format";
import { LEVELS, type Level } from "./levels";
import { axisTop, tallest, type Volume } from "./volume";
import "./logs.css";

/** The levels drawn from the bottom up: what needs attention first, the quiet ones on top. */
const STACK: readonly Level[] = LEVELS;
/** The chart's own coordinates; it stretches to the width of the view. */
const WIDTH = 1_000;
const HEIGHT = 100;

/** Stacked bars of lines per level over the range (board Logs.dc.html, frame 4). */
export function LogsVolume({
  volume,
  loaded,
  note,
  hidden,
  onLevels,
  onRange,
}: {
  volume: Volume;
  /** The lines loaded, named when the bars count only those. */
  loaded: number;
  /** Why there is no count of the whole range, when the count query failed or is still running. */
  note: string | null;
  hidden: ReadonlySet<Level>;
  onLevels: (hidden: Set<Level>) => void;
  onRange?: ((from: number, to: number) => void) | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const number = new Intl.NumberFormat(language);
  const top = axisTop(tallest(volume));
  const span = Math.max(1, volume.to - volume.from);
  const x = (ms: number) => ((ms - volume.from) / span) * WIDTH;
  const clock = new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
    ...(span > 2 * 86_400_000 ? { day: "2-digit", month: "2-digit" } : {}),
    ...(timeZone === null ? {} : { timeZone }),
  });
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((share) => volume.from + share * span);
  const present = LEVELS.filter((level) => volume.totals[level] > 0);
  const onlyUnknown = present.length === 1 && present[0] === "unknown";
  const svgRef = useRef<SVGSVGElement>(null);
  const [drag, setDrag] = useState<{ start: number; end: number } | null>(null);

  function timeAt(clientX: number): number {
    const box = svgRef.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return volume.from;
    const share = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
    return volume.from + share * span;
  }

  function onPointerDown(event: PointerEvent<SVGSVGElement>) {
    if (onRange === undefined || event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const at = timeAt(event.clientX);
    setDrag({ start: at, end: at });
  }

  function onPointerMove(event: PointerEvent<SVGSVGElement>) {
    if (drag !== null) {
      setDrag({ ...drag, end: timeAt(event.clientX) });
    }
  }

  function onPointerUp() {
    if (drag === null) return;
    const from = Math.min(drag.start, drag.end);
    const to = Math.max(drag.start, drag.end);
    setDrag(null);
    // A click is no range: at least a hundredth of the chart.
    if (onRange !== undefined && to - from > span / 100) {
      onRange(Math.floor(from), Math.ceil(to));
    }
  }

  function onLegend(event: MouseEvent<HTMLButtonElement>, level: Level) {
    const next = new Set(hidden);
    // Mod+click (explore.logsLevel): Cmd on a Mac, Ctrl elsewhere.
    if (isMac() ? event.metaKey : event.ctrlKey) {
      if (next.has(level)) next.delete(level);
      else next.add(level);
    } else {
      const only = present.every((other) => (other === level) !== hidden.has(other));
      next.clear();
      if (!only) {
        for (const other of LEVELS) if (other !== level) next.add(other);
      }
    }
    onLevels(next);
  }

  const caption =
    volume.basis === "count"
      ? t("logs.volume.whole", { step: stepText(volume.stepMs, language) })
      : t("logs.volume.loaded", {
          count: number.format(loaded),
          step: stepText(volume.stepMs, language),
        });

  return (
    <section className="logs-volume" aria-label={t("logs.volume.title")}>
      <header className="logs-volume__head">
        <h3 className="logs-volume__title">{t("logs.volume.title")}</h3>
        <span className="logs-volume__caption">{caption}</span>
        <div
          className="logs-volume__legend"
          title={t("logs.volume.legendHint", {
            click: shortcutText("explore.logsLevel", language),
          })}
        >
          {present.map((level) => (
            <button
              key={level}
              type="button"
              className="logs-volume__key"
              data-level={level}
              aria-pressed={!hidden.has(level)}
              onClick={(event) => onLegend(event, level)}
            >
              <span className="logs-level__dot" data-level={level} aria-hidden="true" />
              {t(`logs.level.${level}`)}
              <span className="logs-volume__total">{number.format(volume.totals[level])}</span>
            </button>
          ))}
        </div>
      </header>
      {note === null ? null : <p className="logs-volume__note">{note}</p>}
      <div className="logs-volume__plot">
        <div className="logs-volume__y" aria-hidden="true">
          <span>{number.format(top)}</span>
          <span>{number.format(top / 2)}</span>
          <span>0</span>
        </div>
        <div className="logs-volume__area">
          <svg
            ref={svgRef}
            className="logs-volume__svg"
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={t("logs.volume.chart", {
              from: clock.format(volume.from),
              to: clock.format(volume.to),
            })}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={() => setDrag(null)}
          >
            <line className="logs-volume__grid" x1={0} x2={WIDTH} y1={HEIGHT / 2} y2={HEIGHT / 2} />
            {volume.buckets.map((bucket) => {
              const left = x(Math.max(bucket.from, volume.from));
              const width = Math.max(1, x(Math.min(bucket.to, volume.to)) - left - 1);
              let y = HEIGHT;
              return (
                <g key={bucket.from}>
                  {STACK.map((level) => {
                    const count = hidden.has(level) ? 0 : bucket.counts[level];
                    if (count === 0) return null;
                    const height = (count / top) * HEIGHT;
                    y -= height;
                    return (
                      <rect
                        key={level}
                        className={`logs-volume__bar logs-volume__bar--${onlyUnknown ? "plain" : level}`}
                        x={left}
                        y={y}
                        width={width}
                        height={height}
                      />
                    );
                  })}
                </g>
              );
            })}
            {drag === null ? null : (
              <rect
                className="logs-volume__pick"
                x={x(Math.min(drag.start, drag.end))}
                y={0}
                width={Math.abs(x(drag.end) - x(drag.start))}
                height={HEIGHT}
              />
            )}
          </svg>
          <div className="logs-volume__x" aria-hidden="true">
            {ticks.map((tick) => (
              <span key={tick}>{clock.format(tick)}</span>
            ))}
          </div>
        </div>
      </div>
      {drag === null ? null : (
        <p className="logs-volume__note" aria-live="polite">
          {t("logs.volume.selecting", {
            from: clock.format(Math.min(drag.start, drag.end)),
            to: clock.format(Math.max(drag.start, drag.end)),
          })}
        </p>
      )}
      {/* For screen readers the volume is a table: time slot, level, count. */}
      <table className="visually-hidden">
        <caption>{t("logs.volume.table")}</caption>
        <thead>
          <tr>
            <th scope="col">{t("logs.volume.slot")}</th>
            <th scope="col">{t("logs.col.level")}</th>
            <th scope="col">{t("logs.volume.count")}</th>
          </tr>
        </thead>
        <tbody>
          {volume.buckets.flatMap((bucket) =>
            STACK.filter((level) => bucket.counts[level] > 0).map((level) => (
              <tr key={`${bucket.from}-${level}`}>
                <td>{clock.format(bucket.from)}</td>
                <td>{t(`logs.level.${level}`)}</td>
                <td>{number.format(bucket.counts[level])}</td>
              </tr>
            )),
          )}
        </tbody>
      </table>
    </section>
  );
}
