import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { Frame, Span, TraceSet } from "../../api/generated/shapes";
import { setLanguage } from "../../i18n/i18n";
import { type PanelHost, PanelHostContext } from "../host";
import { getPanel, isTraceList, suggestPanel } from "../registry";
import type { AnyPanelPlugin } from "../types";
import {
  axisTicks,
  criticalPath,
  formatDuration,
  spanRows,
  summariesOfFrame,
  tracesOf,
  treeDepth,
} from "./model";
import { parseTraceOptions } from "./options";
import { checkoutSpans, checkoutTrace, searchFrame, TRACE_ID } from "./test/fixture";

const RANGE = { from: 0, to: 1 };

/** Renders the trace panel and waits for its code, which loads with the first use. */
async function renderTrace(
  input: { trace?: TraceSet; frames?: Frame[] },
  options: unknown = {},
  host: PanelHost = {},
) {
  const plugin = getPanel("trace") as AnyPanelPlugin;
  const { Panel } = plugin;
  const view = render(
    <PanelHostContext value={host}>
      <Panel
        frames={input.frames ?? []}
        traces={
          input.trace === undefined ? [] : [{ refId: "A", datasourceId: "ds", trace: input.trace }]
        }
        options={plugin.options(options)}
        timeRange={RANGE}
        title="Checkout"
      />
    </PanelHostContext>,
  );
  await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
  return view;
}

const rowNames = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-span"));

describe("trace model", () => {
  it("groups spans by trace and finds the root, duration, services and errors", () => {
    const [trace] = tracesOf(checkoutTrace());
    expect(trace?.root.operation).toBe("GET /checkout");
    expect(trace?.duration).toBe(1_240_000);
    expect(trace?.services).toEqual([
      "frontend",
      "checkout",
      "redis",
      "inventory",
      "postgres",
      "payment",
    ]);
    expect(trace?.errors).toBe(3);
    const other = { ...checkoutSpans()[0], traceId: "ab", spanId: "x" } as Span;
    expect(tracesOf({ spans: [...checkoutSpans(), other] })).toHaveLength(2);
  });

  it("orders the spans as a tree and shows every span once, orphans and cycles included", () => {
    const rows = spanRows(checkoutSpans());
    expect(rows.map((row) => row.depth)).toEqual([0, 1, 2, 3, 2, 3, 3, 2, 3, 3, 2, 1]);
    expect(rows[0]?.descendants).toBe(11);
    expect(treeDepth(rows)).toBe(4);
    // A span whose parent was cut, and two spans that name each other as parent.
    const loose: Span[] = [
      { ...(checkoutSpans()[3] as Span), parentSpanId: "gone" },
      { ...(checkoutSpans()[4] as Span), spanId: "p", parentSpanId: "q" },
      { ...(checkoutSpans()[5] as Span), spanId: "q", parentSpanId: "p" },
    ];
    const tree = spanRows(loose);
    expect(tree).toHaveLength(3);
    expect(tree[0]).toMatchObject({ depth: 0, orphan: true });
    expect(tree.map((row) => row.span.spanId).sort()).toEqual(["a1redis000000001", "p", "q"]);
  });

  it("picks the critical path as the server's step does", () => {
    const path = criticalPath(checkoutSpans());
    const operations = checkoutSpans()
      .filter((span) => path.has(span.spanId))
      .map((span) => span.operation);
    // From the root's end backwards: the render, the API call, its order, the charge (with the
    // fraud score and the authorization), the reservation (with its update and lookup), the cart.
    expect(operations).toEqual([
      "GET /checkout",
      "POST /api/checkout",
      "cart.load",
      "GET cart:8812",
      "ReserveItems",
      "stock.lookup",
      "UPDATE stock",
      "Charge",
      "psp.authorize",
      "fraud.score",
      "order.create",
      "render checkout",
    ]);
    // A span running beside a slower one is left out.
    const beside: Span = {
      ...(checkoutSpans()[9] as Span),
      spanId: "beside",
      start: (checkoutSpans()[8] as Span).start + 10_000,
      duration: 50_000,
    };
    expect(criticalPath([...checkoutSpans(), beside]).has("beside")).toBe(false);
  });

  it("reads a search's answer as rows and leaves other tables alone", () => {
    const rows = summariesOfFrame(searchFrame());
    expect(rows?.[0]).toMatchObject({ traceId: TRACE_ID, duration: 1240, spans: 12, errors: 3 });
    expect(isTraceList(searchFrame())).toBe(true);
    const plain: Frame = { fields: [{ name: "v", type: "number", values: [1] }] };
    expect(summariesOfFrame(plain)).toBeNull();
    expect(isTraceList(plain)).toBe(false);
    // Tempo counts the matched spans only: no errors, so no status is claimed.
    const tempo: Frame = {
      fields: [
        ...searchFrame().fields.filter((f) => !["spans", "errors", "services"].includes(f.name)),
        { name: "matchedSpans", type: "number", values: [3, 1] },
      ],
    };
    expect(summariesOfFrame(tempo)?.[0]).toMatchObject({ spans: 3, errors: undefined });
  });

  it("writes durations as people read them, in the language's number format", () => {
    expect(formatDuration(1_240_000, "de")).toBe("1,24 s");
    expect(formatDuration(1_240_000, "en")).toBe("1.24 s");
    expect(formatDuration(85_000, "en")).toBe("85 ms");
    expect(formatDuration(6_400, "en")).toBe("6.4 ms");
    expect(formatDuration(420, "en")).toBe("420 µs");
    expect(formatDuration(90_000_000, "en")).toBe("1.5 min");
    expect(axisTicks(1000)).toEqual([0, 250, 500, 750, 1000]);
    expect(axisTicks(0)).toEqual([0]);
  });

  it("fills in defaults for stored options and bounds them", () => {
    expect(parseTraceOptions(undefined)).toMatchObject({
      view: "auto",
      chart: true,
      events: true,
      collapseDepth: 0,
      variable: "",
    });
    expect(
      parseTraceOptions({
        view: "flame",
        columns: ["start", "nope", "root"],
        variable: "$trace_id",
        collapseDepth: 999,
      }),
    ).toMatchObject({ view: "auto", columns: ["root", "start"], variable: "trace_id" });
    expect(parseTraceOptions({ collapseDepth: 999 }).collapseDepth).toBe(50);
  });

  it("is suggested for traces and for tables of traces", () => {
    expect(suggestPanel([{ shape: "trace", trace: checkoutTrace() }])).toBe("trace");
    expect(suggestPanel([{ shape: "frame", frame: searchFrame() }])).toBe("trace");
  });
});

describe("trace panel: waterfall", () => {
  it("shows one trace as a treegrid with a bar and a duration per span", async () => {
    await renderTrace({ trace: checkoutTrace() });
    const grid = screen.getByRole("treegrid", { name: "Checkout" });
    const rows = within(grid).getAllByRole("row").slice(1);
    expect(rows).toHaveLength(12);
    expect(rows[0]?.getAttribute("aria-level")).toBe("1");
    expect(rows[3]?.getAttribute("aria-level")).toBe("4");
    expect(rows[0]?.getAttribute("aria-expanded")).toBe("true");
    expect(rows[3]?.getAttribute("aria-expanded")).toBeNull();
    expect(within(rows[0] as HTMLElement).getByText("1.24 s")).toBeTruthy();
    // The facts above: id, spans, services, depth and the failed spans.
    expect(screen.getByText(TRACE_ID)).toBeTruthy();
    expect(screen.getByText("3 spans")).toBeTruthy();
  });

  it("says an error as a word, not only with a red bar", async () => {
    const { container } = await renderTrace({ trace: checkoutTrace() });
    const failed = container.querySelector('[data-span="00f067aa0ba902b7"]') as HTMLElement;
    expect(within(failed).getByText("Error")).toBeTruthy();
    expect(failed.querySelector(".trace-row__span--error")).not.toBeNull();
    const fine = container.querySelector('[data-span="a1cart0000000001"]') as HTMLElement;
    expect(within(fine).queryByText("Error")).toBeNull();
    // Bars carry no colour per service: one neutral class, one for errors.
    const classes = new Set(
      [...container.querySelectorAll(".trace-row__span")].map((bar) => bar.className),
    );
    expect([...classes].sort()).toEqual([
      "trace-row__span",
      "trace-row__span trace-row__span--error",
    ]);
  });

  it("opens and closes spans, with the number of hidden spans on a closed one", async () => {
    const user = userEvent.setup();
    const { container } = await renderTrace({ trace: checkoutTrace() });
    const inventory = container.querySelector('[data-span="a1inv00000000001"]') as HTMLElement;
    await user.click(within(inventory).getByRole("button", { name: "Hide child spans" }));
    expect(rowNames()).not.toContain("a1inv00000000002");
    expect(within(inventory).getByText("2 spans")).toBeTruthy();
    expect(inventory.getAttribute("aria-expanded")).toBe("false");
    await user.click(screen.getByRole("button", { name: "Collapse all" }));
    expect(rowNames()).toEqual(["b7ad6b7169203331"]);
    await user.click(screen.getByRole("button", { name: "Expand all" }));
    expect(rowNames()).toHaveLength(12);
  });

  it("starts closed from the depth the options name", async () => {
    await renderTrace({ trace: checkoutTrace() }, { collapseDepth: 2 });
    expect(rowNames()).toEqual(["b7ad6b7169203331", "5f2a90c1d4e8b001", "a1render00000001"]);
  });

  it("moves with the arrow keys and opens the detail with Enter", async () => {
    const user = userEvent.setup();
    const { container } = await renderTrace({ trace: checkoutTrace() });
    const first = container.querySelector('[data-span="b7ad6b7169203331"]') as HTMLElement;
    first.focus();
    await user.keyboard("{ArrowDown}");
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("data-span")).toBe("5f2a90c1d4e8b001"),
    );
    await user.keyboard("{ArrowLeft}");
    expect(rowNames()).toEqual(["b7ad6b7169203331", "5f2a90c1d4e8b001", "a1render00000001"]);
    await user.keyboard("{ArrowRight}");
    expect(rowNames()).toHaveLength(12);
    await user.keyboard("{Enter}");
    const detail = screen.getByRole("complementary", { name: "Span" });
    expect(within(detail).getByText("checkout: POST /api/checkout")).toBeTruthy();
    expect(
      container.querySelector('[data-span="5f2a90c1d4e8b001"]')?.getAttribute("aria-selected"),
    ).toBe("true");
  });

  it("filters to the failed spans and to a text, keeping their ancestors", async () => {
    const user = userEvent.setup();
    await renderTrace({ trace: checkoutTrace() });
    await user.click(screen.getByRole("button", { name: "Errors only" }));
    expect(rowNames()).toEqual([
      "b7ad6b7169203331",
      "5f2a90c1d4e8b001",
      "a1pay00000000001",
      "00f067aa0ba902b7",
    ]);
    await user.click(screen.getByRole("button", { name: "All" }));
    await user.type(screen.getByRole("searchbox", { name: "Find in spans" }), "redis");
    expect(rowNames()).toEqual([
      "b7ad6b7169203331",
      "5f2a90c1d4e8b001",
      "a1cart0000000001",
      "a1redis000000001",
    ]);
  });

  it("shows a span's attributes, events, links and resource", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    const { container } = await renderTrace({ trace: checkoutTrace() }, {}, { traces: { open } });
    await user.click(container.querySelector('[data-span="00f067aa0ba902b7"]') as HTMLElement);
    const detail = screen.getByRole("complementary", { name: "Span" });
    expect(within(detail).getByText("upstream timeout after 3 retries")).toBeTruthy();
    expect(within(detail).getByText("payment: Charge")).toBeTruthy();
    expect(within(detail).getByRole("tab", { name: /Attributess*5/ })).toBeTruthy();
    expect(within(detail).getByText("504")).toBeTruthy();

    await user.click(within(detail).getByRole("tab", { name: /Eventss*2/ }));
    expect(within(detail).getByText("+30 ms")).toBeTruthy();
    expect(within(detail).getByText("connect timeout")).toBeTruthy();
    // The stack trace is folded away, with its length.
    expect(within(detail).getByText("Stack trace (3 lines)")).toBeTruthy();
    expect(within(detail).queryByText("exception.stacktrace")).toBeNull();

    await user.click(within(detail).getByRole("tab", { name: /Linked spanss*1/ }));
    expect(within(detail).getByText("queued for settlement")).toBeTruthy();
    await user.click(within(detail).getByRole("button", { name: "Open trace" }));
    expect(open).toHaveBeenCalledWith("9e1d0c2b5a6f47d08c3e1b2a4d6f71f4");

    await user.click(within(detail).getByRole("tab", { name: "Resource" }));
    expect(within(detail).getByText("pay-7c9f4-2")).toBeTruthy();
    expect(within(detail).getByText("io.opentelemetry.okhttp-3.0")).toBeTruthy();

    await user.click(within(detail).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("complementary", { name: "Span" })).toBeNull();
  });

  it("offers a value as a filter where the page can search, and as a variable on a dashboard", async () => {
    const user = userEvent.setup();
    const filter = vi.fn();
    const set = vi.fn();
    const host: PanelHost = {
      traces: { filter },
      variables: { names: ["order"], accepts: () => true, set },
    };
    const { container } = await renderTrace(
      { trace: checkoutTrace() },
      { variable: "order", variableSource: "order.id" },
      host,
    );
    // The click on the span sets the variable from the attribute the options name.
    await user.click(container.querySelector('[data-span="00f067aa0ba902b7"]') as HTMLElement);
    expect(set).toHaveBeenCalledWith("order", "A-2026-118204");
    expect(screen.getByRole("status").textContent).toBe("$order is now A-2026-118204");
    const detail = screen.getByRole("complementary", { name: "Span" });
    await user.click(within(detail).getByRole("button", { name: "Filter by retry.count" }));
    expect(filter).toHaveBeenCalledWith("retry.count", "3");
    await user.click(within(detail).getByRole("button", { name: "Set $order to POST" }));
    expect(set).toHaveBeenLastCalledWith("order", "POST");
  });

  it("zooms into a part of the trace from the overview and back", async () => {
    const user = userEvent.setup();
    const { container } = await renderTrace({ trace: checkoutTrace() });
    const overview = container.querySelector(".trace-overview") as HTMLElement;
    overview.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 1000, height: 40, right: 1000, bottom: 40 }) as DOMRect;
    overview.setPointerCapture = () => undefined;
    fireEvent.pointerDown(overview, { clientX: 500, pointerId: 1 });
    fireEvent.pointerMove(overview, { clientX: 1000, pointerId: 1 });
    fireEvent.pointerUp(overview, { clientX: 1000, pointerId: 1 });
    // The axis now starts in the middle of the trace.
    expect(screen.getByText("620 ms")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Whole trace" }));
    expect(screen.queryByRole("button", { name: "Whole trace" })).toBeNull();
  });

  it("says when a trace was cut", async () => {
    const cut: TraceSet = {
      ...checkoutTrace(),
      truncated: { limit: 10_000, reason: "trace.span_limit" },
      notices: [
        {
          severity: "warning",
          code: "trace.span_limit",
          params: { limit: "10000", traces: "1", kept: "10000" },
          text: "cut",
        },
      ],
    };
    await renderTrace({ trace: cut });
    expect(screen.getByRole("status").textContent).toContain("1 traces have more than 10000 spans");
  });

  it("reads German", async () => {
    setLanguage("de");
    await renderTrace({ trace: checkoutTrace() });
    expect(screen.getByRole("button", { name: "Nur Fehler" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Kritischer Pfad" })).toBeTruthy();
    expect(screen.getAllByText("1,24 s").length).toBeGreaterThan(0);
  });
});

describe("trace panel: list", () => {
  it("lists a search's traces, the slowest first, with what the source counted", async () => {
    await renderTrace({ frames: [searchFrame()] });
    const table = screen.getByRole("table", { name: "Checkout" });
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(within(rows[1] as HTMLElement).getByText("GET /checkout")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Error")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("OK")).toBeTruthy();
    expect(screen.getByRole("img", { name: "Duration per trace over time" })).toBeTruthy();
    // The search found as many traces as it asked for, and says so.
    expect(screen.getByRole("status").textContent).toContain("asked for 2 traces");
  });

  it("claims no status when the source did not count errors", async () => {
    const tempo: Frame = {
      ...searchFrame(),
      fields: searchFrame().fields.filter((f) => f.name !== "errors"),
    };
    await renderTrace({ frames: [tempo] });
    expect(screen.queryByRole("columnheader", { name: "Status" })).toBeNull();
    expect(screen.queryByText("with errors")).toBeNull();
  });

  it("sorts by start time on demand and shows only the chosen columns", async () => {
    const user = userEvent.setup();
    await renderTrace({ frames: [searchFrame()] }, { columns: ["duration", "start"] });
    expect(screen.queryByRole("columnheader", { name: "Spans" })).toBeNull();
    const start = screen.getByRole("columnheader", { name: /Start/ });
    await user.click(within(start).getByRole("button"));
    expect(start.getAttribute("aria-sort")).toBe("descending");
    await user.click(within(start).getByRole("button"));
    expect(start.getAttribute("aria-sort")).toBe("ascending");
    const rows = screen.getAllByRole("row");
    expect(within(rows[1] as HTMLElement).getByText("a3c01e77")).toBeTruthy();
  });

  it("opens a trace through the page in Explore", async () => {
    const user = userEvent.setup();
    const open = vi.fn();
    await renderTrace({ frames: [searchFrame()] }, {}, { traces: { open } });
    await user.click(screen.getByRole("button", { name: "Open trace 4bf92f35" }));
    expect(open).toHaveBeenCalledWith(TRACE_ID);
  });

  it("sets a dashboard variable from a click on a row and says so", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    const host: PanelHost = {
      variables: { names: ["trace_id"], accepts: () => true, set },
      linkValues: { trace_id: TRACE_ID },
    };
    await renderTrace({ frames: [searchFrame()] }, { variable: "trace_id" }, host);
    expect(screen.getByText("A click on a row sets $trace_id.")).toBeTruthy();
    // The trace the variable holds is marked in the list.
    expect(screen.getAllByRole("row")[1]?.getAttribute("aria-selected")).toBe("true");
    await user.click(screen.getByRole("button", { name: "Open trace a3c01e77" }));
    expect(set).toHaveBeenCalledWith("trace_id", "a3c01e77aa11bb22cc33dd44ee55ff66");
  });

  it("lists several traces of one result and opens one in place", async () => {
    const user = userEvent.setup();
    const second = checkoutSpans().map((span) => ({ ...span, traceId: "ab12cd34ef567890" }));
    await renderTrace({ trace: { spans: [...checkoutSpans(), ...second] } });
    expect(screen.getAllByRole("row")).toHaveLength(3);
    await user.click(screen.getByRole("button", { name: "Open trace ab12cd34" }));
    expect(screen.getByRole("treegrid", { name: "Checkout" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Result list" }));
    expect(screen.getByRole("table", { name: "Checkout" })).toBeTruthy();
  });

  it("is plain rows without anything to open", async () => {
    await renderTrace({ frames: [searchFrame()] });
    expect(screen.queryByRole("button", { name: /Open trace/ })).toBeNull();
  });

  it("says there is no data for an empty result", async () => {
    await renderTrace({ trace: { spans: [] } });
    expect(screen.getByText("The query returned no data.")).toBeTruthy();
  });
});

describe("trace panel: options", () => {
  it("edits the view, the columns and what a click sets", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("trace") as AnyPanelPlugin;
    const { Editor } = plugin;
    const onChange = vi.fn();
    const host: PanelHost = {
      variables: { names: ["trace_id"], accepts: () => true, set: vi.fn() },
    };
    render(
      <PanelHostContext value={host}>
        <Editor options={plugin.options({})} onChange={onChange} />
      </PanelHostContext>,
    );
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull(), { timeout: 4_000 });
    await user.click(screen.getByRole("checkbox", { name: "Spans" }));
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ columns: ["root", "services", "duration", "start", "status"] }),
    );
    await user.click(screen.getByRole("checkbox", { name: "Events in the bar" }));
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ events: false }));
    fireEvent.change(screen.getByLabelText("Closed from depth"), { target: { value: "4" } });
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ collapseDepth: 4 }));
  });
});
