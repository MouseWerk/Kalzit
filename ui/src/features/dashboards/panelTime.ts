import type { TimeRange } from "../../api/generated/shapes";
import type { PanelModel } from "./model";
import { resolveTime } from "./timeRange";

/**
 * A panel's own time options (docs/api/dashboard-features.md): `timeFrom` replaces the dashboard's
 * range with a relative one ending now, `timeShift` moves the range back by a length. Shifts by
 * days, months and years follow the calendar, as the range grammar does; an own range keeps its
 * length and is resolved from the shifted "now".
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
  const shift =
    panel.timeShift !== undefined && isTimeShift(panel.timeShift) ? panel.timeShift : null;
  const back = (ms: number) => (shift === null ? ms : (resolveTime(`now-${shift}`, ms) ?? ms));
  if (panel.timeFrom !== undefined) {
    // The own range is read as if it were the shifted "now": "last 24h, shifted by 1d" is 24
    // hours ending this time yesterday, also when yesterday had 23 or 25 hours.
    const end = back(now);
    const start = resolveTime(panel.timeFrom, end);
    if (start !== null && start < end) {
      return { from: start, to: end };
    }
  }
  return { from: back(range.from), to: back(range.to) };
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
