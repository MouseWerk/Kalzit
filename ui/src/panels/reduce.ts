import type { Field, FieldType, Frame } from "../api/generated/shapes";
import type { MessageKey } from "../i18n/i18n";
import {
  type DisplayValue,
  displayNameOf,
  displayValue,
  type FieldConfig,
  type FieldOptions,
  fieldExtent,
  fieldOptionsFor,
  type Tone,
} from "./fieldConfig/fieldConfig";
import { valueFields } from "./frame";
import { type Reducer, reduceField } from "./stat/reduce";

/** One value field reduced to one value, with the options and range it is shown with. */
export interface ReducedItem {
  frame: Frame;
  field: Field;
  options: FieldOptions;
  name: string;
  type: FieldType;
  display: DisplayValue;
  /** Min and max for gauges and percentage thresholds: the options' own, else the field's. */
  range: { min: number; max: number };
  /** Position among all items, for palette colors. */
  index: number;
}

/**
 * The default range of a gauge: what the options say, else 0 to 100 for percent, 0 to 1 for a
 * fraction, and otherwise from zero (or a negative minimum) to the largest value of the field.
 */
export function defaultRange(field: Field, options: FieldOptions): { min: number; max: number } {
  const extent = fieldExtent(field) ?? { min: 0, max: 0 };
  const fallback =
    options.unit === "percent"
      ? { min: 0, max: 100 }
      : options.unit === "percentunit"
        ? { min: 0, max: 1 }
        : { min: Math.min(0, extent.min), max: extent.max > 0 ? extent.max : 1 };
  const min = options.min ?? fallback.min;
  const max = options.max ?? Math.max(fallback.max, min + 1e-9);
  return { min, max };
}

/** Every value field of every frame, reduced and formatted. */
export function reduceFrames(
  frames: readonly Frame[],
  config: FieldConfig,
  reducer: Reducer,
  language: string,
): ReducedItem[] {
  const items: ReducedItem[] = [];
  for (const frame of frames) {
    for (const field of valueFields(frame)) {
      const options = fieldOptionsFor(field, config);
      const { value, type } = reduceField(field, reducer);
      const range = defaultRange(field, options);
      items.push({
        frame,
        field,
        options,
        name: displayNameOf(field, options),
        type,
        display: displayValue(value, type, options, language, range),
        range,
        index: items.length,
      });
    }
  }
  return items;
}

/** Where a value lies between min and max, 0 to 1, clamped. */
export function fraction(value: number, range: { min: number; max: number }): number {
  const span = range.max - range.min;
  if (!(span > 0)) {
    return value >= range.max ? 1 : 0;
  }
  return Math.min(Math.max((value - range.min) / span, 0), 1);
}

const TONE_NAMES: Partial<Record<Tone, MessageKey>> = {
  ok: "panels.tone.ok",
  warn: "panels.tone.warn",
  critical: "panels.tone.critical",
};

/** The spoken name of a state tone, so color is never the only carrier of meaning. */
export function toneName(tone: Tone | undefined): MessageKey | undefined {
  return tone === undefined ? undefined : TONE_NAMES[tone];
}
