import { type RefObject, useLayoutEffect, useState } from "react";

let context: OffscreenCanvasRenderingContext2D | null | undefined;

/**
 * The width of a text in px at a CSS font, or undefined where text cannot be measured (no
 * OffscreenCanvas, as in the tests). Charts use it to fit axes and labels to what they say.
 */
export function textWidth(text: string, font: string): number | undefined {
  if (context === undefined) {
    context =
      typeof OffscreenCanvas === "undefined" ? null : new OffscreenCanvas(1, 1).getContext("2d");
  }
  if (context === null) {
    return undefined;
  }
  context.font = font;
  return context.measureText(text).width;
}

/** About one character of a small label in px, where text cannot be measured. */
const PX_PER_CHAR = 7;

/** The width of a label, measured at the font when there is one, else estimated. */
export function labelWidth(text: string, font: string | null): number {
  const measured = font === null ? undefined : textWidth(text, font);
  return measured ?? text.length * PX_PER_CHAR;
}

/**
 * The font of a hidden probe element styled like the chart's labels, read once
 * before the first paint, so labels are measured at the size they are drawn.
 */
export function useProbeFont(probe: RefObject<HTMLElement | null>): string | null {
  const [font, setFont] = useState<string | null>(null);
  useLayoutEffect(() => {
    const element = probe.current;
    if (element === null) {
      return;
    }
    const style = getComputedStyle(element);
    setFont(`${style.fontWeight} ${style.fontSize} ${style.fontFamily}`);
  }, [probe]);
  return font;
}
