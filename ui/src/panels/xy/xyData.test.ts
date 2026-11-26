import { describe, expect, it } from "vitest";
import type { Frame } from "../../api/generated/shapes";
import { EMPTY_FIELD_CONFIG } from "../fieldConfig/fieldConfig";
import { parseXYOptions } from ".";
import { drawnPoints } from "./XYChart";
import {
  buildXY,
  colorStep,
  densityGrid,
  MAX_XY_POINTS,
  pickFields,
  pointSize,
  sampleEvenly,
  seriesKeys,
  type XYData,
} from "./xyData";

const shop: Frame = {
  fields: [
    { name: "kunde", type: "string", values: ["Aurora", "Bergwerk", "Calcit", "Delta"] },
    { name: "region", type: "string", values: ["Nord", "Ost", "Nord", "Süd"] },
    { name: "warenkorb", type: "number", values: [58.2, 96, 142, null] },
    { name: "lieferzeit", type: "number", values: [2.4, 3.6, 5.1, 4] },
    { name: "bestellungen", type: "int64", values: ["312", "204", "188", "90"] },
  ],
};

const auto = parseXYOptions({});

describe("XY field mapping", () => {
  it("takes the first number field as X and every further one as a Y series, by hand the named ones", () => {
    const picked = pickFields(shop, auto);
    expect("kind" in picked).toBe(false);
    if ("kind" in picked) return;
    expect(picked.x.name).toBe("warenkorb");
    expect(picked.ys.map((f) => f.name)).toEqual(["lieferzeit", "bestellungen"]);
    // A field that sets the size is no Y series.
    const sized = pickFields(shop, { ...auto, sizeBy: "bestellungen" });
    expect("kind" in sized ? [] : sized.ys.map((f) => f.name)).toEqual(["lieferzeit"]);
    const manual = pickFields(shop, { mapping: "manual", x: "lieferzeit", y: "warenkorb" });
    expect("kind" in manual ? null : [manual.x.name, manual.ys[0]?.name]).toEqual([
      "lieferzeit",
      "warenkorb",
    ]);
  });

  it("names what is missing instead of guessing", () => {
    const one: Frame = {
      fields: [
        { name: "region", type: "string", values: ["Nord"] },
        { name: "umsatz", type: "number", values: [1] },
      ],
    };
    expect(pickFields(one, auto)).toEqual({ kind: "oneNumber", field: "umsatz" });
    expect(pickFields({ fields: [one.fields[0] as Frame["fields"][number]] }, auto)).toEqual({
      kind: "noNumbers",
    });
    // Text is never converted to a number silently.
    expect(pickFields(shop, { mapping: "manual", x: "kunde", y: "lieferzeit" })).toEqual({
      kind: "missing",
      field: "kunde",
    });
  });
});

describe("XY series", () => {
  it("builds one point per row with X and Y, skipping rows without either", () => {
    const data = buildXY(
      [shop],
      { mapping: "manual", x: "warenkorb", y: "lieferzeit" },
      EMPTY_FIELD_CONFIG,
      "Others",
    ) as XYData;
    expect(data.series).toHaveLength(1);
    expect(data.series[0]?.xs).toEqual([58.2, 96, 142]);
    expect(data.series[0]?.ys).toEqual([2.4, 3.6, 5.1]);
    expect(data.series[0]?.rows).toEqual([0, 1, 2]);
    expect(data.total).toBe(3);
    expect(data.x).toEqual({ min: 58.2, max: 142 });
  });

  it("splits a series per value of a field, each with its own colour", () => {
    const data = buildXY(
      [shop],
      { mapping: "manual", x: "warenkorb", y: "lieferzeit", seriesBy: "region" },
      EMPTY_FIELD_CONFIG,
      "Others",
    ) as XYData;
    expect(data.series.map((s) => [s.name, s.xs])).toEqual([
      ["Nord", [58.2, 142]],
      ["Ost", [96]],
      ["Süd", []],
    ]);
    expect(data.series.map((s) => s.colorClass)).toEqual(["series-1", "series-2", "series-3"]);
  });

  it("keeps eight values apart and puts the rest together as Others", () => {
    const values = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "i", "j"];
    expect(seriesKeys(values.slice(0, 8))).toEqual({
      keys: ["a", "b", "c", "d", "e", "f", "g", "h"],
      others: false,
    });
    // Nine values or more: the seven most frequent (i twice), in the order they appear.
    expect(seriesKeys(values)).toEqual({ keys: ["a", "b", "c", "d", "e", "f", "i"], others: true });
    const frame: Frame = {
      fields: [
        { name: "k", type: "string", values },
        { name: "x", type: "number", values: values.map((_, i) => i) },
        { name: "y", type: "number", values: values.map((_, i) => i * 2) },
      ],
    };
    const data = buildXY(
      [frame],
      { mapping: "auto", seriesBy: "k" },
      EMPTY_FIELD_CONFIG,
      "Others",
    ) as XYData;
    const others = data.series.at(-1);
    expect(others?.name).toBe("Others");
    expect(others?.others).toBe(true);
    expect(others?.colorClass).toBe("series-mono");
    expect(others?.xs).toEqual([6, 7, 10]);
  });
});

describe("many points", () => {
  it("samples evenly above the limit and keeps the axes on every point", () => {
    expect(sampleEvenly(10, 20)).toBeNull();
    expect(Array.from(sampleEvenly(10, 4) ?? [])).toEqual([0, 2, 5, 7]);
    const n = 72_672;
    const frame: Frame = {
      fields: [
        { name: "x", type: "number", values: Array.from({ length: n }, (_, i) => n - i) },
        { name: "y", type: "number", values: Array.from({ length: n }, (_, i) => i % 100) },
      ],
    };
    const data = buildXY([frame], auto, EMPTY_FIELD_CONFIG, "Others") as XYData;
    const { drawn, sampled } = drawnPoints(data);
    expect(sampled).toBe(true);
    expect(drawn).toHaveLength(MAX_XY_POINTS);
    // The readout walks the drawn points in X order.
    const xs = drawn.map((d) => data.series[d.s]?.xs[d.i] as number);
    expect(xs).toEqual([...xs].sort((a, b) => a - b));
    expect(data.x).toEqual({ min: 1, max: n });
  });

  it("counts every point into the density grid", () => {
    const grid = densityGrid(
      [{ xs: [0, 0.1, 0.9, 1, 5], ys: [0, 0.1, 0.9, 1, 5] }],
      { min: 0, max: 1 },
      { min: 0, max: 1 },
      2,
      2,
    );
    expect(grid.max).toBe(2);
    expect(grid.cells.sort((a, b) => a.column - b.column)).toEqual([
      { column: 0, row: 0, count: 2 },
      { column: 1, row: 1, count: 2 },
    ]);
  });
});

describe("size and colour by field", () => {
  it("scales sizes linearly between the bounds and colours along five steps", () => {
    const sizes = { sizeMin: 3, sizeMax: 9 };
    expect(pointSize(90, { min: 90, max: 312 }, sizes)).toBe(3);
    expect(pointSize(312, { min: 90, max: 312 }, sizes)).toBe(9);
    expect(pointSize(201, { min: 90, max: 312 }, sizes)).toBe(6);
    expect(pointSize(null, { min: 0, max: 1 }, sizes)).toBe(3);
    expect(colorStep(0, { min: 0, max: 100 })).toBe(1);
    expect(colorStep(100, { min: 0, max: 100 })).toBe(5);
    expect(colorStep(50, { min: 0, max: 100 })).toBe(3);
  });

  it("reads stored options within their bounds", () => {
    expect(
      parseXYOptions({ sizeMin: 0, sizeMax: 99, pointOpacity: 1, show: "bars" }),
    ).toMatchObject({
      mapping: "auto",
      sizeMin: 3,
      sizeMax: 9,
      pointOpacity: 55,
      show: "points",
    });
    expect(parseXYOptions({ sizeMin: 12, sizeMax: 4, x: "a", mapping: "manual" })).toMatchObject({
      sizeMin: 12,
      sizeMax: 12,
      x: "a",
      mapping: "manual",
    });
  });
});
