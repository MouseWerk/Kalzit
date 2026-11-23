import { describe, expect, it } from "vitest";
import { fitAxisLabels } from "./axis";
import { categoryLabels, clampLabel, FLAT_HEIGHT } from "./categoryAxis";
import { legendFit, MIN_PLOT_HEIGHT } from "./fieldConfig/Legend";
import { axisTickFormat } from "./fieldConfig/units";
import { shortenText } from "./measure";
import { outsideLabelsFit, pieGeometry } from "./piechart";
import { statLayout } from "./stat";

const NBSP = " ";
/** Seven px per character, as the charts estimate where text cannot be measured. */
const estimate = (text: string) => text.length * 7;

describe("value axis ticks", () => {
  const axis = (ticks: number[], unit?: string, decimals?: number, language = "en") =>
    ticks.map(axisTickFormat(ticks, unit, decimals, language));

  it("write round currency ticks without decimals, whatever the field's decimals", () => {
    expect(axis([0, 500, 1000, 1500], "currency:EUR")).toEqual(["€0", "€500", "€1,000", "€1,500"]);
    expect(axis([0, 500, 1000, 1500], "currency:EUR", 2)).toEqual([
      "€0",
      "€500",
      "€1,000",
      "€1,500",
    ]);
    expect(axis([1000, 1500], "currency:EUR", 2, "de")).toEqual([`1.000${NBSP}€`, `1.500${NBSP}€`]);
  });

  it("keep the digits a tick needs, and ticks distinct", () => {
    expect(axis([0, 0.25, 0.5, 0.75], "currency:USD")).toEqual(["$0", "$0.25", "$0.5", "$0.75"]);
    expect(axis([0, 2.5, 5], "percent", 3)).toEqual(["0%", "2.5%", "5%"]);
    expect(axis([0, 1500, 3000], "celsius", 2)).toEqual([
      `0${NBSP}°C`,
      `1,500${NBSP}°C`,
      `3,000${NBSP}°C`,
    ]);
    // Close ticks of a large value: all take the digits that tell them apart.
    const close = axis([1000.1, 1000.2, 1000.3]);
    expect(new Set(close).size).toBe(3);
  });

  it("keep dates as the unit writes them", () => {
    const at = Date.UTC(2026, 0, 2);
    expect(axis([at], "dateIso")).toEqual(["2026-01-02T00:00:00.000Z"]);
  });
});

describe("value axis labels in a narrow chart", () => {
  it("keep their unit while it fits", () => {
    expect(
      fitAxisLabels([0, 20_000, 40_000], "suffix:orders", undefined, "en", 200, estimate),
    ).toEqual(["0", `20${NBSP}k${NBSP}orders`, `40${NBSP}k${NBSP}orders`]);
  });

  it("drop the unit, then shorten, instead of taking half the width", () => {
    expect(
      fitAxisLabels([0, 20_000, 40_000], "suffix:orders", undefined, "en", 40, estimate),
    ).toEqual(["0", `20${NBSP}k`, `40${NBSP}k`]);
    const cut = fitAxisLabels([0, 2_500_000], undefined, undefined, "en", 21, estimate);
    expect(cut.every((text) => estimate(text) <= 21)).toBe(true);
  });
});

describe("category names under bars", () => {
  const names = ["Calcite Lamp", "Spar Pen", "Quartz Mug", "Feldspar Pad", "Mica Cup", "Opal Box"];
  const widths = names.map(estimate);

  it("stand straight under their bars while they fit", () => {
    const fit = categoryLabels(widths, 120, 100, 300);
    expect(fit).toMatchObject({ every: 1, turned: false, height: FLAT_HEIGHT });
  });

  it("turn in a narrow chart, so all six show instead of two", () => {
    // Six categories in about 230 px of plot: 38 px each, the longest name is 84 px.
    const fit = categoryLabels(widths, 38, 60, 200);
    expect(fit.turned).toBe(true);
    expect(fit.every).toBe(1);
    // Shortened to the room under the plot (40 % of the height) and left of the first one.
    expect(fit.maxWidth).toBeLessThanOrEqual(60 / Math.SQRT1_2);
    expect(fit.height).toBeLessThanOrEqual(200 * 0.4 + 1);
  });

  it("thin out evenly where even turned names would be stubs", () => {
    const fit = categoryLabels(widths, 12, 10, 60);
    expect(fit.turned).toBe(false);
    expect(fit.every).toBe(Math.ceil((84 + 12) / 12));
  });

  it("move a straight name at the edge inward instead of cutting it", () => {
    expect(clampLabel(10, 60, 300)).toBe(30);
    expect(clampLabel(295, 60, 300)).toBe(270);
    expect(clampLabel(150, 60, 300)).toBe(150);
  });

  it("shorten a name with an ellipsis to the room it has", () => {
    expect(shortenText("Spar Pen", 100, null)).toBe("Spar Pen");
    const short = shortenText("Calcite Lamp", 50, null);
    expect(short.endsWith("…")).toBe(true);
    expect(estimate(short)).toBeLessThanOrEqual(50);
    expect(shortenText("Calcite Lamp", 3, null)).toBe("");
  });
});

describe("legend in a small panel", () => {
  it("goes below a narrow drawing and leaves it its least height", () => {
    const fit = legendFit(300, 200, "right");
    expect(fit.stacked).toBe(true);
    expect(fit.room).toBe(200 - MIN_PLOT_HEIGHT - 4);
    expect(fit.hidden).toBe(false);
    expect(fit.namesOnly).toBe(true);
  });

  it("stays beside a wide drawing with its values", () => {
    expect(legendFit(800, 200, "right")).toEqual({
      stacked: false,
      room: null,
      hidden: false,
      namesOnly: false,
    });
  });

  it("stays beside the drawing in a short, wide panel, names only", () => {
    // 6 x 4 grid units at 1440 px: about 280 x 130 px.
    expect(legendFit(280, 130, "right")).toEqual({
      stacked: false,
      room: null,
      hidden: false,
      namesOnly: true,
    });
  });

  it("is left out where not even a line fits", () => {
    expect(legendFit(300, 100, "bottom").hidden).toBe(true);
  });
});

describe("pie in a narrow panel", () => {
  it("keeps a readable circle and drops outside labels that would shrink it to a dot", () => {
    expect(outsideLabelsFit(600, 300, 60)).toBe(true);
    expect(outsideLabelsFit(160, 160, 60)).toBe(false);
    // The circle always fits its box.
    const { cx, cy, radius } = pieGeometry(160, 120, 0);
    expect(cx - radius).toBeGreaterThanOrEqual(0);
    expect(cx + radius).toBeLessThanOrEqual(160);
    expect(cy + radius).toBeLessThanOrEqual(120);
  });
});

describe("stat values", () => {
  it("stand side by side in a short panel instead of being cut off below", () => {
    // Two values (orders, refunds) at 6 x 4 grid units.
    const layout = statLayout(2, 300, 110);
    expect(layout.columns).toBe(2);
    expect(layout.compact).toBe(true);
  });

  it("stack in a tall narrow panel and keep their trend lines", () => {
    const layout = statLayout(2, 200, 400);
    expect(layout.columns).toBe(1);
    expect(layout.compact).toBe(false);
    expect(layout.small).toBe(false);
  });

  it("write the number smaller where a box is tight", () => {
    expect(statLayout(4, 300, 60).small).toBe(true);
  });
});
