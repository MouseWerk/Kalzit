import type { TimeRange } from "../../api/generated/shapes";
import type { PanelModel } from "./model";
import { resolveTime } from "./timeRange";

/**
 * A panel's own time options (docs/api/dashboard-features.md): `timeFrom` replaces the dashboard's
 * range with a relative one ending now, `timeShift` moves the range back by a length. Shifts by
 * days, months and years follow the calendar, as the range grammar does.
 */

/** Panel types with a time axis, which draw annotations. */
export const TIME_PANELS: ReadonlySet<string> = new Set(["timeseries"]);

const RELATIVE_FROM = /^now-(\d{1,5}[smhdwMy])(?:\/[smhdwMy])?$/;
const DURATION = /^\d{1,5}[smhdwMy]$/;

/** Whether text is a valid `timeFrom` (as the server checks it). */
export function isTimeFrom(text: string): boolean {
  return text.startsWith("now-") && resolveTime(text, 0) !== null;
}

/** Whether text is a valid `timeShift`: one to five digits (not zero) and a unit. */
export function isTimeShift(text: string): boolean {
  return DURATION.test(text) && Number.parseInt(text, 10) > 0;
}

/** The range one panel's queries run with. */
export function panelRange(panel: PanelModel, range: TimeRange, now: number): TimeRange {
  let { from, to } = range;
  if (panel.timeFrom !== undefined) {
    const start = resolveTime(panel.timeFrom, now);
    if (start !== null && start < now) {
      from = start;
      to = now;
    }
  }
  if (panel.timeShift !== undefined && isTimeShift(panel.timeShift)) {
    const back = (ms: number) => resolveTime(`now-${panel.timeShift}`, ms) ?? ms;
    from = back(from);
    to = back(to);
  }
  return { from, to };
}

/** The parts of a header note: the length of the own range ("24h") and the shift ("1d"). */
export function timeNote(panel: PanelModel): { last?: string; shift?: string } {
  const note: { last?: string; shift?: string } = {};
  if (panel.timeFrom !== undefined) {
    note.last = RELATIVE_FROM.exec(panel.timeFrom)?.[1] ?? panel.timeFrom;
  }
  if (panel.timeShift !== undefined) {
    note.shift = panel.timeShift;
  }
  return note;
}
