import { describe, expect, it, vi } from "vitest";
import type { PanelHost } from "../../../panels/host";
import type { PanelSeries } from "../../../panels/types";
import {
  actOnEvent,
  CLICK_KEY,
  clickSetting,
  pluginOptions,
  storedClickSetting,
  withClickSetting,
} from "./events";

/** A dashboard with `$region` (free), `$tier` (custom: gold, silver) and `$hosts` (multi). */
function dashboard() {
  const set = vi.fn();
  const setMany = vi.fn();
  const setRange = vi.fn();
  const host: PanelHost = {
    orgId: "org-1",
    variables: {
      names: ["region", "tier"],
      multi: ["hosts"],
      accepts: (name, value) => name !== "tier" || value === "gold" || value === "silver",
      set,
      setMany,
    },
    setRange,
  };
  return { host, set, setMany, setRange };
}

const SERIES: PanelSeries[] = [
  {
    refId: "A",
    result: {
      shape: "frame",
      frame: {
        fields: [
          { name: "host", type: "string", values: ["web-1", "web-2", null] },
          { name: "cpu", type: "number", values: [0.5, 0.7, 0.9] },
        ],
      },
    },
  } as PanelSeries,
  {
    refId: "B",
    result: {
      shape: "documents",
      documents: {
        documents: [{ _id: "d1", customer: { id: "c-7" } }],
        schema: [],
        notices: [],
      },
    },
  } as PanelSeries,
  {
    refId: "G",
    result: {
      shape: "graph",
      graph: {
        nodes: [{ id: "n1", labels: ["Customer"], properties: { name: "Acme" } }],
        edges: [{ id: "e1", type: "BOUGHT", from: "n1", to: "n1", properties: {} }],
        schema: { labels: [], edgeTypes: [], propertyKeys: {} },
      },
    },
  } as PanelSeries,
];

describe("events of a plugin panel", () => {
  it("sets the dashboard's time range like the time picker", () => {
    const { host, setRange } = dashboard();
    expect(actOnEvent({ type: "range", from: 1000, to: 2000 }, host, SERIES, {})).toEqual({
      kind: "range",
      from: 1000,
      to: 2000,
    });
    expect(setRange).toHaveBeenCalledWith(1000, 2000);
    // Outside the dates a browser can write, or a page without a range: nothing happens.
    expect(actOnEvent({ type: "range", from: 0, to: 9e15 }, host, SERIES, {}).kind).toBe("dropped");
    expect(actOnEvent({ type: "range", from: 0, to: 1 }, { orgId: "o" }, SERIES, {}).kind).toBe(
      "dropped",
    );
    expect(setRange).toHaveBeenCalledTimes(1);
  });

  it("sets only variables the dashboard lets a panel set, with values they take", () => {
    const { host, set, setMany } = dashboard();
    expect(actOnEvent({ type: "setVariable", name: "region", value: "eu" }, host, [], {})).toEqual({
      kind: "variable",
      name: "region",
      value: "eu",
      result: "set",
    });
    expect(set).toHaveBeenCalledWith("region", "eu");
    // A custom variable takes only its options.
    expect(
      actOnEvent({ type: "setVariable", name: "tier", value: "platinum" }, host, [], {}),
    ).toMatchObject({ kind: "variable", result: "refused" });
    // A constant, an interval or a variable the dashboard does not have: never.
    expect(actOnEvent({ type: "setVariable", name: "env", value: "x" }, host, [], {}).kind).toBe(
      "dropped",
    );
    // A list only for a multi-value variable.
    expect(
      actOnEvent({ type: "setVariable", name: "region", value: ["a", "b"] }, host, [], {}).kind,
    ).toBe("dropped");
    expect(
      actOnEvent({ type: "setVariable", name: "hosts", value: ["a", "b", "a"] }, host, [], {}),
    ).toMatchObject({ kind: "variables", result: "set" });
    expect(setMany).toHaveBeenCalledWith("hosts", ["a", "b"]);
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("sets the clicked item's value when the panel has a click setting", () => {
    const { host, set } = dashboard();
    const click = (source: string, variable = "region") => ({
      [CLICK_KEY]: { variable, source },
    });
    expect(
      actOnEvent(
        { type: "click", refId: "A", target: "row", index: 1 },
        host,
        SERIES,
        click("host"),
      ),
    ).toMatchObject({ kind: "variable", value: "web-2", result: "set" });
    expect(
      actOnEvent(
        { type: "click", refId: "B", target: "document", index: 0 },
        host,
        SERIES,
        click("customer.id"),
      ),
    ).toMatchObject({ value: "c-7" });
    expect(
      actOnEvent({ type: "click", refId: "G", target: "node", id: "n1" }, host, SERIES, click("")),
    ).toMatchObject({ value: "n1" });
    expect(set.mock.calls).toEqual([
      ["region", "web-2"],
      ["region", "c-7"],
      ["region", "n1"],
    ]);
    // Without a setting, outside the results, an empty cell, an unknown id: nothing.
    for (const [event, options] of [
      [{ type: "click", refId: "A", target: "row", index: 0 }, {}],
      [{ type: "click", refId: "A", target: "row", index: 9 }, click("host")],
      [{ type: "click", refId: "A", target: "row", index: 2 }, click("host")],
      [{ type: "click", refId: "Z", target: "row", index: 0 }, click("host")],
      [{ type: "click", refId: "G", target: "node", id: "n9" }, click("name")],
      [{ type: "click", refId: "A", target: "row", index: 0 }, click("host", "env")],
    ] as const) {
      expect(actOnEvent(event, host, SERIES, options).kind).toBe("dropped");
    }
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("sets a multi-value variable from a selection", () => {
    const { host, setMany } = dashboard();
    const options = { [CLICK_KEY]: { variable: "hosts", source: "host" } };
    expect(
      actOnEvent({ type: "select", refId: "A", rows: [0, 1, 2, 7] }, host, SERIES, options),
    ).toMatchObject({ kind: "variables", values: ["web-1", "web-2"], result: "set" });
    expect(setMany).toHaveBeenCalledWith("hosts", ["web-1", "web-2"]);
    // A single-value variable is not set from a selection.
    const single = { [CLICK_KEY]: { variable: "region", source: "host" } };
    expect(actOnEvent({ type: "select", refId: "A", rows: [0] }, host, SERIES, single).kind).toBe(
      "dropped",
    );
  });

  it("keeps the click setting apart from the plugin's own options", () => {
    const stored = { decimals: 2, [CLICK_KEY]: { variable: "$region\u0007", source: " host " } };
    expect(clickSetting(stored)).toEqual({ variable: "region", source: "host" });
    expect(storedClickSetting(stored)).toEqual({
      [CLICK_KEY]: { variable: "region", source: "host" },
    });
    expect(storedClickSetting({ [CLICK_KEY]: { variable: "" } })).toEqual({});
    expect(pluginOptions(stored)).toEqual({ decimals: 2 });
    expect(withClickSetting({ decimals: 3 }, stored)).toEqual({
      decimals: 3,
      [CLICK_KEY]: stored[CLICK_KEY],
    });
  });
});
