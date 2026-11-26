import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { TRACE_ID } from "../../panels/trace/test/fixture";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { pickOption } from "../../test/select";
import { addStep, catalogNames, catalogOption, openCatalog } from "../../test/stepCatalog";
import { addTraceSources, JAEGER_ID, TEMPO_ID } from "../datasources/test/fakeTraces";

function open(id: string) {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addTraceSources(server.areas.datasources);
  const app = renderApp("/explore");
  const ready = (async () => {
    await pickOption(app.user, await screen.findByRole("combobox", { name: "Data source" }), id);
  })();
  return { server, ...app, ready };
}

const queries = (server: ReturnType<typeof installFakeServer>) =>
  (server.areas.datasources.queries as unknown as QueryRequest[]).map(
    (request) => request.queries[0],
  );
const lastQuery = (server: ReturnType<typeof installFakeServer>) => queries(server).at(-1)?.query;

describe("Explore with a Tempo source", () => {
  it("searches without a query language and shows the TraceQL it stands for", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    fireEvent.change(await screen.findByRole("combobox", { name: "Service" }), {
      target: { value: "frontend" },
    });
    await user.click(screen.getByRole("button", { name: "Tag" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Name of tag 1" }), {
      target: { value: "http.status_code" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Value of tag 1" }), {
      target: { value: "500" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Duration at least" }), {
      target: { value: "500ms" },
    });
    await user.click(screen.getByRole("button", { name: "Error" }));
    expect(
      screen.getByText(
        '{ resource.service.name = "frontend" && .http.status_code = 500 && duration >= 500ms && status = error }',
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    const result = await screen.findByRole("region", { name: "Result" });
    expect(lastQuery(server)).toEqual({
      service: "frontend",
      tags: { "http.status_code": "500" },
      minDuration: "500ms",
      status: "error",
    });
    // The answer is a table of traces, drawn as the trace list.
    const list = await within(result).findByRole("table", { name: "Result" });
    expect(within(list).getAllByRole("row")).toHaveLength(3);
    expect(within(result).getByText(/asked for 2 traces/)).toBeTruthy();
  });

  it("opens a trace from the list as a waterfall and goes back to the list", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    fireEvent.change(await screen.findByRole("combobox", { name: "Service" }), {
      target: { value: "frontend" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await user.click(await screen.findByRole("button", { name: "Open trace 4bf92f35" }));
    const grid = await screen.findByRole("treegrid", { name: "Result" });
    expect(lastQuery(server)).toEqual({ traceId: TRACE_ID });
    expect(within(grid).getAllByRole("row")).toHaveLength(13);
    // The editor shows the trace id that ran.
    expect(screen.getByRole("textbox", { name: "Trace ID" })).toHaveProperty("value", TRACE_ID);

    // A value of a span becomes a tag of the search the trace came from.
    await user.click(grid.querySelector('[data-span="00f067aa0ba902b7"]') as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Filter by retry.count" }));
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ service: "frontend", tags: { "retry.count": "3" } }),
    );
    await user.click(await screen.findByRole("button", { name: "Open trace 4bf92f35" }));
    await screen.findByRole("treegrid", { name: "Result" });
    await user.click(screen.getByRole("button", { name: "Result list" }));
    await screen.findByRole("table", { name: "Result" });
    expect(lastQuery(server)).toEqual({ service: "frontend", tags: { "retry.count": "3" } });
    expect(screen.queryByRole("button", { name: "Result list" })).toBeNull();
  });

  it("opens the search as TraceQL in the editor", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    fireEvent.change(await screen.findByRole("combobox", { name: "Service" }), {
      target: { value: "frontend" },
    });
    await user.click(screen.getByRole("button", { name: "Open in TraceQL" }));
    const editor = screen.getByRole("textbox", { name: "TraceQL" }) as HTMLTextAreaElement;
    expect(editor.value).toBe('{ resource.service.name = "frontend" }');
    expect(screen.getByRole("button", { name: "TraceQL" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ traceql: '{ resource.service.name = "frontend" }' }),
    );
    // Back in the search, the fields are as they were.
    await user.click(
      within(screen.getByRole("group", { name: "Kind of query" })).getByRole("button", {
        name: "Search",
      }),
    );
    expect(screen.getByRole("combobox", { name: "Service" })).toHaveProperty("value", "frontend");
  });

  it("holds back a search with a duration the server would refuse", async () => {
    const { user, ready } = open(TEMPO_ID);
    await ready;
    fireEvent.change(await screen.findByRole("textbox", { name: "Duration at least" }), {
      target: { value: "half a second" },
    });
    expect(screen.getByText(/A number with us, ms/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", true);
    await user.clear(screen.getByRole("textbox", { name: "Duration at least" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Duration at least" }), {
      target: { value: "500ms" },
    });
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", false);
    // A dashboard variable is filled in, and checked, by the server: it is not held back here.
    fireEvent.change(screen.getByRole("textbox", { name: "Duration at least" }), {
      target: { value: "$min_duration" },
    });
    expect(screen.queryByText(/A number with us, ms/)).toBeNull();
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", false);
  });

  it("names the next step beside a search without hits", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    fireEvent.change(await screen.findByRole("combobox", { name: "Service" }), {
      target: { value: "nobody" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("heading", { name: "No traces found" })).toBeTruthy();
    const before = queries(server).length;
    await user.click(screen.getByRole("button", { name: "Last 24 hours" }));
    await waitFor(() => expect(queries(server).length).toBe(before + 1));
    await user.click(await screen.findByRole("button", { name: "Reset filters" }));
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Service" })).toHaveProperty("value", ""),
    );
    expect(screen.queryByRole("region", { name: "Result" })).toBeNull();
  });

  it("says in plain words that a trace id is unknown", async () => {
    const { user, ready } = open(TEMPO_ID);
    await ready;
    await user.click(await screen.findByRole("button", { name: "Trace ID" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Trace ID" }), {
      target: { value: "5d1f0e3aa8b24c71" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("There is no trace 5d1f0e3aa8b24c71.")).toBeTruthy();
    // An id that is no hex does not run at all.
    fireEvent.change(screen.getByRole("textbox", { name: "Trace ID" }), {
      target: { value: "not-hex" },
    });
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", true);
  });

  it("turns a trace into a table and a graph only through visible steps", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    await user.click(await screen.findByRole("button", { name: "Trace ID" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Trace ID" }), {
      target: { value: TRACE_ID },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("treegrid", { name: "Result" });

    // The catalog offers the trace steps, each with the shape it makes.
    const catalog = await openCatalog(user);
    expect(catalogNames(catalog).slice(0, 6)).toEqual([
      "Filter spans",
      "Critical path",
      "Spans as a table",
      "Traces as a table",
      "Service map",
      "Span tree as a graph",
    ]);
    const preview = () => within(catalog).getByRole("complementary");
    await user.hover(catalogOption(catalog, "Service map"));
    expect(within(preview()).getByText("Trace → Graph")).toBeTruthy();
    await user.hover(catalogOption(catalog, "Spans as a table"));
    expect(within(preview()).getByText("Trace → Table")).toBeTruthy();
    await user.click(catalogOption(catalog, "Spans as a table"));
    // The step runs with the query on the server; its answer is a table of the spans.
    await waitFor(() =>
      expect(queries(server).at(-1)?.steps).toEqual([
        expect.objectContaining({ type: "spanTable", frame: "A" }),
      ]),
    );
    expect(await screen.findByText("12 rows, 3 fields")).toBeTruthy();
    expect(screen.getByText(/Runs on the server · changes the shape/)).toBeTruthy();
    await waitFor(() =>
      expect(screen.getByRole("combobox", { name: "Visualization" }).textContent).toContain(
        "Table",
      ),
    );
    // Turning the step off shows the trace again: nothing changed its shape silently.
    await user.click(screen.getByRole("checkbox", { name: "Active" }));
    expect(await screen.findByRole("treegrid", { name: "Result" })).toBeTruthy();
  });

  it("asks before a service map over very many spans", async () => {
    const { server, user, ready } = open(TEMPO_ID);
    await ready;
    await user.click(await screen.findByRole("button", { name: "Trace ID" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Trace ID" }), {
      target: { value: "b16" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByRole("treegrid", { name: "Result" });
    await addStep(user, "Service map");
    expect(
      await screen.findByText(
        "This step would read 120000 spans, more than 100000. Confirm to compute it anyway.",
      ),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Compute anyway" }));
    await waitFor(() =>
      expect(queries(server).at(-1)?.steps).toEqual([
        expect.objectContaining({ type: "serviceMap", confirmLarge: true }),
      ]),
    );
    expect(await screen.findByText("3 nodes, 2 edges")).toBeTruthy();
    // The confirmation is a visible part of the step and can be taken back.
    expect(screen.getByRole("checkbox", { name: "Also above 100,000 spans" })).toHaveProperty(
      "checked",
      true,
    );
  });
});

describe("Explore with a Jaeger source", () => {
  it("offers no TraceQL and searches only inside a service", async () => {
    const { server, user, ready } = open(JAEGER_ID);
    await ready;
    await screen.findByRole("combobox", { name: "Service" });
    expect(screen.queryByRole("button", { name: "TraceQL" })).toBeNull();
    expect(screen.queryByText("As TraceQL")).toBeNull();
    expect(screen.getByText(/Jaeger searches inside one service/)).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Operation" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Run query" })).toHaveProperty("disabled", true);
    fireEvent.change(screen.getByRole("combobox", { name: "Service" }), {
      target: { value: "checkout" },
    });
    const operation = screen.getByRole("combobox", { name: "Operation" });
    expect(operation).toHaveProperty("disabled", false);
    // The operations offered are those of the service chosen.
    const options = document.getElementById(operation.getAttribute("list") ?? "");
    expect([...(options?.querySelectorAll("option") ?? [])].map((o) => o.value)).toEqual([
      "POST /api/checkout",
    ]);
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() => expect(lastQuery(server)).toEqual({ service: "checkout" }));
  });

  it("starts from the first service the source lists", async () => {
    const { server, user, ready } = open(JAEGER_ID);
    await ready;
    await user.click(await screen.findByRole("button", { name: "Traces with an error" }));
    await waitFor(() =>
      expect(lastQuery(server)).toEqual({ service: "frontend", status: "error" }),
    );
  });
});
