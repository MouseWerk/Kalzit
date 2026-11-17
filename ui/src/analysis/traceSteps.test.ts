import { describe, expect, it } from "vitest";
import type { TargetOutcome } from "../features/dashboards/results";
import { SERVICE_MAP, traceOutcome } from "../features/datasources/test/fakeTraces";
import { checkoutTrace, TRACE_ID } from "../panels/trace/test/fixture";
import { UTC_CALENDAR } from "./expr";
import { graphStepsByQuery, namedInputs, runPanelSteps } from "./panel";
import { asSteps, isTraceStep, runSteps, runsWithQuery, type Step } from "./steps";
import { TRACE_STEP_OUT, TRACE_STEP_TYPES, traceStepComplete } from "./traceSteps";

const step = (id: string, rest: Record<string, unknown>): Step =>
  ({ id, frame: "A", ...rest }) as unknown as Step;

/** The fake server's answer for the trace with these steps, as an outcome of query A. */
function answered(steps: Step[]): TargetOutcome[] {
  const outcome = traceOutcome({
    refId: "A",
    datasourceId: "ds",
    query: { traceId: TRACE_ID },
    steps,
  });
  return "result" in outcome
    ? [{ refId: "A", result: outcome.result, ...(outcome.steps ? { steps: outcome.steps } : {}) }]
    : [{ refId: "A", error: outcome.error }];
}

describe("trace steps", () => {
  it("are steps the server runs with the query, each with the shape it makes", () => {
    expect(TRACE_STEP_TYPES.map((type) => TRACE_STEP_OUT[type])).toEqual([
      "trace",
      "trace",
      "frame",
      "frame",
      "graph",
      "graph",
    ]);
    const stored = asSteps([
      { id: "s1", type: "filterSpans", frame: "A", status: "error" },
      { id: "s2", type: "spanTable", frame: "A", attributes: ["http.status_code"] },
      { id: "s3", type: "flamegraph", frame: "A" },
    ]);
    expect(stored.map((s) => s.type)).toEqual(["filterSpans", "spanTable"]);
    expect(stored.every(isTraceStep)).toBe(true);
    expect(stored.every(runsWithQuery)).toBe(true);
  });

  it("go to the server in order, up to a step the server would refuse", () => {
    const steps = [
      step("s1", { type: "filterSpans", status: "error" }),
      step("s2", { type: "serviceMap" }),
      step("s3", { type: "countLabels" }),
      step("s4", { type: "group", by: [], aggregations: [] }),
    ];
    // The trace steps and the graph step after them run with the query; the table step does not.
    expect(
      graphStepsByQuery(steps)
        .get("A")
        ?.map((s) => s.id),
    ).toEqual(["s1", "s2", "s3"]);
    const unfinished = [
      step("s1", { type: "filterSpans", minDurationMs: 500, maxDurationMs: 100 }),
      step("s2", { type: "spanTable" }),
    ];
    expect(graphStepsByQuery(unfinished).has("A")).toBe(false);
    expect(graphStepsByQuery([{ ...steps[0], disabled: true } as Step]).has("A")).toBe(false);
  });

  it("check a span filter's form as the server does", () => {
    const filter = (attribute: unknown) =>
      traceStepComplete({ type: "filterSpans", frame: "A", attribute } as never);
    expect(traceStepComplete({ type: "criticalPath", frame: "A" })).toBe(true);
    expect(filter(undefined)).toBe(true);
    expect(filter({ key: "", op: "exists" })).toBe(false);
    expect(filter({ key: "http.status_code", op: "gte", value: 500 })).toBe(true);
    expect(filter({ key: "http.status_code", op: "gte", value: "500" })).toBe(false);
    expect(filter({ key: "peer.service", op: "contains", value: "" })).toBe(false);
  });

  it("show nothing of their own until the server answered", () => {
    const steps = [step("s1", { type: "spanTable" })];
    const run = runSteps(steps, namedInputs(answered([])), { calendar: UTC_CALENDAR });
    // The trace is still a trace; the step waits and nothing failed.
    expect(run.traces.map((x) => x.name)).toEqual(["A"]);
    expect(run.frames).toEqual([]);
    expect(run.steps[0]).toMatchObject({ id: "s1", waiting: true, skipped: false });
    expect(run.failed).toBeUndefined();
  });

  it("take the server's result: a smaller trace, a table, a graph", () => {
    const filter = [step("s1", { type: "filterSpans", status: "error" })];
    const kept = runPanelSteps(filter, answered(filter), UTC_CALENDAR);
    expect(kept.traces[0]?.trace.spans).toHaveLength(3);
    expect(kept.steps[0]).toMatchObject({ ranIn: "server", skipped: false });

    const table = [...filter, step("s2", { type: "spanTable" })];
    const rows = runPanelSteps(table, answered(table), UTC_CALENDAR);
    expect(rows.traces).toEqual([]);
    expect(rows.frames[0]?.frame.fields[0]?.values).toHaveLength(3);

    const map = [step("s1", { type: "serviceMap" })];
    const graph = runPanelSteps(map, answered(map), UTC_CALENDAR);
    expect(graph.graphs[0]?.graph).toEqual(SERVICE_MAP);
    expect(graph.traces).toEqual([]);

    // A table step after the server's steps runs in the browser on the table they made.
    const grouped = [
      ...table,
      step("s3", {
        type: "group",
        by: ["service"],
        aggregations: [{ field: "duration", op: "max" }],
      }),
    ];
    const max = runPanelSteps(grouped, answered(grouped.slice(0, 2)), UTC_CALENDAR);
    expect(max.frames[0]?.frame.fields.map((f) => f.name)).toEqual(["service", "max(duration)"]);
  });

  it("show the trace again in Explore when the step is turned off", () => {
    const steps = [step("s1", { type: "spanTable" })];
    const own: TargetOutcome[] = [
      { refId: "A", result: { shape: "trace", trace: checkoutTrace() } },
    ];
    const on = runPanelSteps(steps, own, UTC_CALENDAR, answered(steps));
    expect(on.frames).toHaveLength(1);
    expect(on.traces).toEqual([]);
    const off = [{ ...steps[0], disabled: true } as Step];
    const again = runPanelSteps(off, own, UTC_CALENDAR, undefined);
    expect(again.traces).toHaveLength(1);
    expect(again.frames).toEqual([]);
  });

  it("say why a trace step cannot read a table, and pass the server's refusal on", () => {
    const frame = { fields: [{ name: "v", type: "number" as const, values: [1] }] };
    const run = runSteps([step("s1", { type: "criticalPath" })], [{ name: "A", frame }], {
      calendar: UTC_CALENDAR,
    });
    expect(run.failed?.error.reason).toBe("steps.not_trace");

    const large: Step[] = [step("s1", { type: "serviceMap" })];
    const outcome = traceOutcome({
      refId: "A",
      datasourceId: "ds",
      query: { traceId: "b16" },
      steps: large,
    });
    const refused = runPanelSteps(
      large,
      "result" in outcome
        ? [{ refId: "A", result: outcome.result, steps: outcome.steps ?? [] }]
        : [],
      UTC_CALENDAR,
    );
    expect(refused.failed?.error).toMatchObject({
      reason: "steps.trace_graph_large",
      params: { spans: "120000", limit: "100000" },
    });
  });
});
