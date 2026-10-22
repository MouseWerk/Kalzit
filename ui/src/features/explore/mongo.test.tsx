import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { emptyModel } from "../dashboards/model";
import { addDashboard, latest } from "../dashboards/test/fakeDashboards";
import { addMongoSource, MONGO_ID } from "../datasources/test/fakeDatasources";

async function open() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addMongoSource(server.areas.datasources);
  const rendered = renderApp("/explore");
  // The first page load of a file also loads the route and the data sources; give it time.
  const picker = await screen.findByLabelText("Data source", {}, { timeout: 4000 });
  fireEvent.change(picker, { target: { value: MONGO_ID } });
  fireEvent.change(await screen.findByLabelText("Collection"), { target: { value: "orders" } });
  return { server, ...rendered };
}

type Opened = Awaited<ReturnType<typeof open>>;

const sent = (server: Opened["server"]) =>
  server.areas.datasources.queries.at(-1) as unknown as QueryRequest;

/** Adds a stage of `name` and fills its JSON, as pasting does. */
async function addStage(user: Opened["user"], name: string, json: string) {
  // Label queries: role queries over the whole page are slow, and these steps only set up.
  fireEvent.change(screen.getByLabelText("Stage to add"), { target: { value: name } });
  await user.click(screen.getByText("Add stage"));
  const editors = screen.getAllByLabelText(/^Stage \d+$/);
  fireEvent.change(editors.at(-1) as HTMLElement, { target: { value: json } });
}

const MATCH = '{"$match": {"status": "paid"}}';

describe("Explore with MongoDB", () => {
  it("runs a pipeline built from stages, sent as text in the server's form", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", MATCH);
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("2 documents.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Visualization" })).toHaveProperty(
      "value",
      "documents",
    );
    // The stage text goes out as written, so its key order is kept.
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      pipeline: `[\n${MATCH}\n]`,
    });
  });

  it("keeps the key order of a $sort as typed", async () => {
    const { server, user } = await open();
    await addStage(user, "$sort", '{"$sort": {"status": 1, "rating": -1}}');
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByText("3 documents.");
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      pipeline: '[\n{"$sort": {"status": 1, "rating": -1}}\n]',
    });
  });

  it("previews the documents after one stage, on demand and limited", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", MATCH);
    await addStage(user, "$limit", '{"$limit": 1}');
    const before = server.areas.datasources.queries.length;
    await user.click(screen.getByRole("button", { name: "Preview after stage 1" }));
    const preview = await screen.findByRole("region", { name: "Documents after stage 1" });
    expect(await within(preview).findByText("2 documents.")).toBeTruthy();
    expect(within(preview).getByRole("tree", { name: "Documents after stage 1" })).toBeTruthy();
    expect(server.areas.datasources.queries).toHaveLength(before + 1);
    expect(sent(server).queries[0]).toMatchObject({
      limit: 20,
      query: { collection: "orders", pipeline: `[\n${MATCH}\n]` },
    });
  });

  it("reorders, disables and removes stages, and keeps the focus on the moved stage", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", MATCH);
    await addStage(user, "$limit", '{"$limit": 1}');
    await user.click(screen.getByRole("button", { name: "Move stage 2 up" }));
    expect(screen.getByRole("heading", { name: "Stage 1: $limit" })).toBeTruthy();
    // At the top its Up button is off; the focus moves to its Down button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move stage 1 down" }));

    await user.click(screen.getAllByRole("checkbox", { name: "Run this stage" })[0] as HTMLElement);
    expect(screen.getByRole("heading", { name: "Stage 1: $limit (disabled)" })).toBeTruthy();
    // The server's form has no place for disabled stages; the editor says so.
    expect(screen.getByText(/1 disabled stages do not run and are not saved/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        pipeline: `[\n${MATCH}\n]`,
      }),
    );
    expect(await screen.findByText("2 documents.")).toBeTruthy();

    // Enabled again, it runs in its new place.
    await user.click(screen.getAllByRole("checkbox", { name: "Run this stage" })[0] as HTMLElement);
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        pipeline: `[\n{"$limit": 1},\n${MATCH}\n]`,
      }),
    );

    await user.click(screen.getByRole("button", { name: "Remove stage 1" }));
    expect(screen.getAllByLabelText(/^Stage \d+$/)).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add stage" }));
  });

  it("keeps invalid JSON in the field, says why, and runs the last valid stage", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", MATCH);
    const stage = screen.getByLabelText("Stage 1");
    fireEvent.change(stage, { target: { value: '{"$match": {"status": ' } });
    expect(screen.getByText(/This is not valid JSON/)).toBeTruthy();
    expect(stage).toHaveProperty("value", '{"$match": {"status": ');
    fireEvent.change(stage, { target: { value: '{"$out": "copy"}' } });
    expect(screen.getByText(/\$out writes data; Kalzit only reads/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        pipeline: `[\n${MATCH}\n]`,
      }),
    );
  });

  it("shows the server's refusal of a stage it does not allow", async () => {
    const { user } = await open();
    await addStage(user, "$match", '{"$currentOp": {}}');
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText(/\$currentOp is not allowed/)).toBeTruthy();
  });

  it("edits the whole pipeline in the raw view and sends that text as typed", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", MATCH);
    await user.click(screen.getByRole("radio", { name: "Raw pipeline" }));
    const raw = screen.getByRole("textbox", { name: "Raw pipeline" });
    expect((raw as HTMLTextAreaElement).value).toBe(`[\n${MATCH}\n]`);
    const typed = '[{"$sort": {"rating": -1}},   {"$limit": 2}]';
    fireEvent.change(raw, { target: { value: typed } });
    await user.click(screen.getByRole("radio", { name: "Stages" }));
    expect(screen.getByRole("heading", { name: "Stage 1: $sort" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stage 2: $limit" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({ collection: "orders", pipeline: typed }),
    );
  });

  it("runs a find with filter, projection, sort, skip and limit as texts and numbers", async () => {
    const { server, user } = await open();
    await user.click(screen.getByRole("radio", { name: "Find" }));
    fireEvent.change(screen.getByLabelText("Filter"), { target: { value: '{"status": "paid"}' } });
    fireEvent.change(screen.getByLabelText("Projection of fields"), {
      target: { value: '{"status": 1}' },
    });
    fireEvent.change(screen.getByLabelText("Sort"), { target: { value: '{"rating": -1}' } });
    fireEvent.change(screen.getByLabelText("Skip"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Limit"), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("1 documents.")).toBeTruthy();
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      filter: '{"status": "paid"}',
      projection: '{"status": 1}',
      sort: '{"rating": -1}',
      skip: 1,
      limit: 1,
    });
  });

  it("turns a click on a value into a typed $match stage and runs it", async () => {
    const { server, user } = await open();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("3 documents.")).toBeTruthy();
    const result = screen.getByRole("tree", { name: "Result" });
    await user.click(within(result).getAllByRole("treeitem")[1] as HTMLElement);
    const id = within(result)
      .getAllByRole("treeitem")
      .find((row) => row.querySelector(".doc-tree__key")?.textContent === "_id") as HTMLElement;
    await user.click(id);
    await user.click(screen.getByRole("button", { name: "Filter by value" }));

    const stage = '{"$match": {"_id": {"$oid":"665f1c2e9b1e4a0001a1b002"}}}';
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        pipeline: `[\n${stage}\n]`,
      }),
    );
    expect(await screen.findByText("1 documents.")).toBeTruthy();
    // The filter is a visible stage of the query, editable like any other.
    expect(screen.getByRole("heading", { name: "Stage 1: $match" })).toBeTruthy();
    expect(screen.getByLabelText("Stage 1")).toHaveProperty("value", stage);
  });

  it("draws documents as a time series only through a visible projection step of the panel", async () => {
    const { server, user, location } = await open();
    addDashboard(server.areas.dashboards, "d-ops", emptyModel("Operations"));
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByText("3 documents.");
    fireEvent.change(screen.getByLabelText("Visualization"), { target: { value: "timeseries" } });
    expect(screen.getByText(/Add a projection step/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add projection step" }));
    fireEvent.change(screen.getByLabelText("Field path of column 1"), {
      target: { value: "createdAt" },
    });
    await user.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByLabelText("Field path of column 2"), {
      target: { value: "total" },
    });
    fireEvent.change(screen.getByLabelText("Name of column 2"), { target: { value: "Total" } });
    // The step applies to the result at hand; the query itself stays in the server's form.
    expect(await screen.findByRole("group", { name: "Result" })).toBeTruthy();
    expect(sent(server).queries[0]?.query).toEqual({ collection: "orders", pipeline: "[]" });

    // Added to a dashboard, the step goes with the panel.
    await user.click(screen.getByRole("button", { name: "Add to dashboard…" }));
    const dialog = screen.getByRole("dialog", { name: "Add to dashboard" });
    fireEvent.change(await within(dialog).findByLabelText("Dashboard"), {
      target: { value: "d-ops" },
    });
    await user.click(within(dialog).getByRole("button", { name: "Add panel" }));
    await waitFor(() => expect(location().pathname).toBe("/dashboards/d-ops"));
    const saved = latest(server.areas.dashboards.dashboards[0] as never);
    expect(saved.model.panels[0]).toMatchObject({
      type: "timeseries",
      targets: [{ refId: "A", query: { collection: "orders", pipeline: "[]" } }],
      transformations: [
        {
          type: "toFrame",
          refId: "A",
          columns: [{ path: "createdAt" }, { path: "total", name: "Total" }],
        },
      ],
    });
  });

  it("completes stage names and the fields of the collection", async () => {
    const { user } = await open();
    await addStage(user, "$match", "{}");
    const stage = screen.getByLabelText("Stage 1");
    fireEvent.change(stage, { target: { value: '{"$ma' } });
    const options = () =>
      within(screen.getByRole("listbox", { name: "Suggestions" }))
        .getAllByRole("option")
        .map((option) => option.textContent);
    expect(options()).toEqual(["$matchkeyword"]);
    fireEvent.change(stage, { target: { value: '{"$match": {"sta' } });
    expect(options()).toEqual(["statuscolumn"]);
  });
});
