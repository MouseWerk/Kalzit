import { describe, expect, it } from "vitest";
import type { Field, Frame } from "../api/generated/shapes";
import { distinctSeriesNames, nameFrame } from "./frame";
import { stateTone } from "./state/stateData";
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
  it("colors state words by what they mean, in English and German", () => {
    expect(stateTone("OK")).toBe("ok");
    expect(stateTone("up")).toBe("ok");
    expect(stateTone("degraded")).toBe("warn");
    expect(stateTone("down")).toBe("critical");
    expect(stateTone("Fehler")).toBe("critical");
    expect(stateTone("unknown")).toBe("neutral");
    expect(stateTone("Nord")).toBeUndefined();
  });
});
