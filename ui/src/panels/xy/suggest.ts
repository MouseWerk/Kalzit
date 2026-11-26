import type { Frame } from "../../api/generated/shapes";
import { isNumeric, rowCount } from "../frame";
import { ascent } from "../trend/trendData";

/**
 * A frame of numbers only, two or more of them and two rows or more: no time to draw over and no
 * text to name categories, so the numbers belong against each other (the XY chart).
 */
export function looksLikeXY(frame: Frame): boolean {
  return (
    rowCount(frame) >= 2 &&
    frame.fields.length >= 2 &&
    frame.fields.every((field) => isNumeric(field.type))
  );
}

/** Such a frame whose first number field ascends strictly: a series over a number (Trend). */
export function looksLikeTrend(frame: Frame): boolean {
  const first = frame.fields[0];
  return looksLikeXY(frame) && first !== undefined && ascent(first.values).kind === "ascending";
}
