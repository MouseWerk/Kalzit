import { describe, expect, it } from "vitest";
import type { Field, Frame } from "../api/generated/shapes";
import type { FieldConfig } from "./fieldConfig/fieldConfig";
import { distinctSeriesNames, nameFrame } from "./frame";
import { stateData, stateTone } from "./state/stateData";
import { buildSeries } from "./timeseries/series";

const field = (name: string, labels?: Record<string, string>): Field => ({
  name,
  type: "number",
  values: [1, 2],
  ...(labels === undefined ? {} : { labels }),
});

const frame = (...fields: Field[]): Frame => ({
  fields: [{ name: "time", type: "time", values: [0, 1] }, ...fields],
});

describe("series names", () => {
  it("names Prometheus series by the labels that differ between them", () => {
    const series = ["node-a:9100", "node-b:9100"].map((instance) => ({
      name: `{instance="${instance}", job="node"}`,
      field: field(`{instance="${instance}", job="node"}`, { instance, job: "node" }),
      fixed: false,
    }));
    expect(distinctSeriesNames(series)).toEqual(["node-a:9100", "node-b:9100"]);
  });

  it("keeps the metric name in front of the differing labels", () => {
    const series = ["a", "b"].map((host) => ({
      name: `cpu{host="${host}"}`,
      field: field("cpu", { __name__: "cpu", host }),
      fixed: false,
    }));
    expect(distinctSeriesNames(series)).toEqual(["cpu a", "cpu b"]);
  });

  it("tells equal names apart by their query's reference id, else by number", () => {
    const byQuery = ["A", "B"].map((refId) => ({
      name: "amount",
      field: field("amount"),
      refId,
      fixed: false,
    }));
    expect(distinctSeriesNames(byQuery)).toEqual(["amount (A)", "amount (B)"]);
    const sameQuery = [0, 1].map(() => ({ name: "amount", field: field("amount"), fixed: false }));
    expect(distinctSeriesNames(sameQuery)).toEqual(["amount (1)", "amount (2)"]);
  });

  it("leaves names the author set alone", () => {
    const series = [0, 1].map(() => ({ name: "Sales", field: field("amount"), fixed: true }));
    expect(distinctSeriesNames(series)).toEqual(["Sales", "Sales"]);
  });

  it("reads the reference ids of the frames a panel's steps produced", () => {
    const a = frame(field("amount"));
    const b = frame(field("amount"));
    nameFrame(a, "A");
    nameFrame(b, "B");
    expect(buildSeries([a, b]).map((s) => s.name)).toEqual(["amount (A)", "amount (B)"]);
  });
});

describe("state tones", () => {
  it("colors whole state words by what they mean, in English and German", () => {
    expect(stateTone("OK")).toBe("ok");
    expect(stateTone(" up ")).toBe("ok");
    expect(stateTone("degraded")).toBe("warn");
    expect(stateTone("down")).toBe("critical");
    expect(stateTone("Fehler")).toBe("critical");
    expect(stateTone("unknown")).toBe("neutral");
  });

  it("leaves values alone that only contain a state word, or are no clear state", () => {
    for (const text of ["Down Under", "error_budget_ok", "up-to-date", "Nord", "red", "running"]) {
      expect(stateTone(text), text).toBeUndefined();
    }
  });

  const states = frame({ name: "status", type: "string", values: ["down", "ok"] });
  const colorOf = (config: FieldConfig, words = true) =>
    stateData([states], config, "en", words)?.rows[0]?.values.map((v) => v?.colorClass);

  it("puts mappings and the field color before state words, and state words before the palette", () => {
    expect(colorOf({ defaults: {}, overrides: [] })).toEqual(["tone--critical", "tone--ok"]);
    const mapped: FieldConfig = {
      defaults: { mappings: [{ type: "value", value: "down", tone: "warn" }] },
      overrides: [],
    };
    expect(colorOf(mapped)).toEqual(["tone--warn", "tone--ok"]);
    const colored: FieldConfig = { defaults: { color: "chart-3" }, overrides: [] };
    expect(colorOf(colored)).toEqual(["tone--chart-3", "tone--chart-3"]);
  });

  it("uses the palette when known state words are switched off", () => {
    expect(colorOf({ defaults: {}, overrides: [] }, false)).toEqual(["series-1", "series-2"]);
  });

  it("shows one row per query and holds each state until its query reports a new one", () => {
    const api: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 20] },
        { name: "api", type: "string", values: ["ok", "down"] },
      ],
    };
    const search: Frame = {
      fields: [
        { name: "time", type: "time", values: [10] },
        { name: "search", type: "string", values: ["degraded"] },
      ],
    };
    const data = stateData([api, search], { defaults: {}, overrides: [] }, "en");
    expect(data?.times).toEqual([0, 10, 20]);
    expect(data?.rows.map((r) => r.name)).toEqual(["api", "search"]);
    expect(data?.rows[0]?.values.map((v) => v?.text)).toEqual(["ok", "ok", "down"]);
    expect(data?.rows[1]?.values.map((v) => v?.text ?? null)).toEqual([
      null,
      "degraded",
      "degraded",
    ]);
  });

  it("gives status history no cell where a query has no point of its own", () => {
    const fast: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 10, 20] },
        { name: "api", type: "string", values: ["ok", "ok", "down"] },
      ],
    };
    const slow: Frame = {
      fields: [
        { name: "time", type: "time", values: [0, 20] },
        { name: "batch", type: "string", values: ["ok", "degraded"] },
      ],
    };
    const data = stateData([fast, slow], { defaults: {}, overrides: [] }, "en", true, false);
    expect(data?.rows[1]?.values.map((v) => v?.text ?? null)).toEqual(["ok", null, "degraded"]);
  });

  it("tells rows of two queries with the same field apart by their reference ids", () => {
    const a: Frame = {
      fields: [
        { name: "time", type: "time", values: [0] },
        { name: "status", type: "string", values: ["ok"] },
      ],
    };
    const b: Frame = {
      fields: [
        { name: "time", type: "time", values: [0] },
        { name: "status", type: "string", values: ["down"] },
      ],
    };
    nameFrame(a, "A");
    nameFrame(b, "B");
    const data = stateData([a, b], { defaults: {}, overrides: [] }, "en");
    expect(data?.rows.map((r) => r.name)).toEqual(["status (A)", "status (B)"]);
  });

  it("names labelled state fields by the label that differs, after the metric name", () => {
    const up = (instance: string): Frame => ({
      fields: [
        { name: "time", type: "time", values: [0] },
        {
          name: `up{instance="${instance}", job="node"}`,
          type: "string",
          values: ["ok"],
          labels: { __name__: "up", instance, job: "node" },
        },
      ],
    });
    const data = stateData([up("a"), up("b")], { defaults: {}, overrides: [] }, "en");
    expect(data?.rows.map((r) => r.name)).toEqual(["up a", "up b"]);
  });
});
