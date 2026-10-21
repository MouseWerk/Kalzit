import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { QueryRequest } from "../../api/generated/shapes";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { addMongoSource, MONGO_ID } from "../datasources/test/fakeDatasources";

async function open() {
  const server = installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  addMongoSource(server.areas.datasources);
  const rendered = renderApp("/explore");
  const { user } = rendered;
  fireEvent.change(await screen.findByLabelText("Data source"), { target: { value: MONGO_ID } });
  fireEvent.change(await screen.findByLabelText("Collection"), { target: { value: "orders" } });
  return { server, ...rendered };
}

const sent = (server: Awaited<ReturnType<typeof open>>["server"]) =>
  server.areas.datasources.queries.at(-1) as unknown as QueryRequest;

/** Adds a stage of `name` and fills its JSON, as pasting does. */
async function addStage(
  user: Awaited<ReturnType<typeof open>>["user"],
  name: string,
  json: string,
) {
  // Label queries: role queries over the whole page are slow, and these steps only set up.
  fireEvent.change(screen.getByLabelText("Stage to add"), { target: { value: name } });
  await user.click(screen.getByText("Add stage"));
  const editors = screen.getAllByLabelText(/^Stage \d+$/);
  fireEvent.change(editors.at(-1) as HTMLElement, { target: { value: json } });
}

describe("Explore with MongoDB", () => {
  it("runs a pipeline built from stages and shows the documents in the explorer", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", '{"$match": {"status": "paid"}}');
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("2 documents.")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Visualization" })).toHaveProperty(
      "value",
      "documents",
    );
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      mode: "aggregate",
      pipeline: [{ $match: { status: "paid" } }],
    });
  });

  it("previews the documents after one stage, on demand and limited", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", '{"$match": {"status": "paid"}}');
    await addStage(user, "$limit", '{"$limit": 1}');
    const before = server.areas.datasources.queries.length;
    await user.click(screen.getByRole("button", { name: "Preview after stage 1" }));
    const preview = await screen.findByRole("region", { name: "Documents after stage 1" });
    expect(await within(preview).findByText("2 documents.")).toBeTruthy();
    expect(within(preview).getByRole("tree", { name: "Documents after stage 1" })).toBeTruthy();
    expect(server.areas.datasources.queries).toHaveLength(before + 1);
    expect(sent(server).queries[0]).toMatchObject({
      limit: 20,
      query: {
        collection: "orders",
        mode: "aggregate",
        pipeline: [{ $match: { status: "paid" } }],
      },
    });
  });

  it("reorders, disables and removes stages, and keeps the focus on the moved stage", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", '{"$match": {"status": "paid"}}');
    await addStage(user, "$limit", '{"$limit": 1}');
    await user.click(screen.getByRole("button", { name: "Move stage 2 up" }));
    expect(screen.getByRole("heading", { name: "Stage 1: $limit" })).toBeTruthy();
    // At the top its Up button is off; the focus moves to its Down button.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Move stage 1 down" }));

    await user.click(screen.getAllByRole("checkbox", { name: "Run this stage" })[0] as HTMLElement);
    expect(screen.getByRole("heading", { name: "Stage 1: $limit (disabled)" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        mode: "aggregate",
        pipeline: [{ $match: { status: "paid" } }],
        disabledStages: [{ index: 0, stage: { $limit: 1 } }],
      }),
    );
    expect(await screen.findByText("2 documents.")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Remove stage 1" }));
    expect(screen.getAllByRole("textbox", { name: /^Stage \d+$/ })).toHaveLength(1);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Add stage" }));
  });

  it("keeps invalid JSON in the field, says why, and runs the last valid stage", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", '{"$match": {"status": "paid"}}');
    const stage = screen.getByRole("textbox", { name: "Stage 1" });
    fireEvent.change(stage, { target: { value: '{"$match": {"status": ' } });
    expect(screen.getByText(/This is not valid JSON/)).toBeTruthy();
    expect(stage).toHaveProperty("value", '{"$match": {"status": ');
    fireEvent.change(stage, { target: { value: '{"$out": "copy"}' } });
    expect(screen.getByText(/\$out writes data; Kalzit only reads/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toMatchObject({
        pipeline: [{ $match: { status: "paid" } }],
      }),
    );
  });

  it("edits the whole pipeline in the raw view", async () => {
    const { server, user } = await open();
    await addStage(user, "$match", '{"$match": {"status": "paid"}}');
    await user.click(screen.getByRole("radio", { name: "Raw pipeline" }));
    const raw = screen.getByRole("textbox", { name: "Raw pipeline" });
    expect(JSON.parse((raw as HTMLTextAreaElement).value)).toEqual([
      { $match: { status: "paid" } },
    ]);
    fireEvent.change(raw, { target: { value: '[{"$sort": {"rating": -1}}, {"$limit": 2}]' } });
    await user.click(screen.getByRole("radio", { name: "Stages" }));
    expect(screen.getByRole("heading", { name: "Stage 1: $sort" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Stage 2: $limit" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toMatchObject({
        pipeline: [{ $sort: { rating: -1 } }, { $limit: 2 }],
      }),
    );
  });

  it("runs a find with filter, projection, sort and limit", async () => {
    const { server, user } = await open();
    await user.click(screen.getByRole("radio", { name: "Find" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter" }), {
      target: { value: '{"status": "paid"}' },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Projection of fields" }), {
      target: { value: '{"status": 1}' },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Sort" }), {
      target: { value: '{"total": -1}' },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Limit" }), { target: { value: "1" } });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByText("1 documents.")).toBeTruthy();
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      mode: "find",
      filter: { status: "paid" },
      projection: { status: 1 },
      sort: { total: -1 },
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

    await waitFor(() =>
      expect(sent(server).queries[0]?.query).toEqual({
        collection: "orders",
        mode: "aggregate",
        pipeline: [{ $match: { _id: { $oid: "665f1c2e9b1e4a0001a1b002" } } }],
      }),
    );
    expect(await screen.findByText("1 documents.")).toBeTruthy();
    // The filter is a visible stage of the query, editable like any other.
    expect(screen.getByRole("heading", { name: "Stage 1: $match" })).toBeTruthy();
    expect(screen.getByRole("textbox", { name: "Stage 1" })).toHaveProperty(
      "value",
      JSON.stringify({ $match: { _id: { $oid: "665f1c2e9b1e4a0001a1b002" } } }, null, 2),
    );
  });

  it("draws documents as a time series only through a visible projection step", async () => {
    const { server, user } = await open();
    await user.click(screen.getByRole("button", { name: "Run query" }));
    await screen.findByText("3 documents.");
    await user.selectOptions(screen.getByRole("combobox", { name: "Visualization" }), "timeseries");
    expect(screen.getByText(/Add a projection step to the query/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Add projection step" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Field path of column 1" }), {
      target: { value: "createdAt" },
    });
    await user.click(screen.getByRole("button", { name: "Add column" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Field path of column 2" }), {
      target: { value: "total" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Name of column 2" }), {
      target: { value: "Total" },
    });
    await user.click(screen.getByRole("button", { name: "Run query" }));
    expect(await screen.findByRole("group", { name: "Result" })).toBeTruthy();
    expect(sent(server).queries[0]?.query).toEqual({
      collection: "orders",
      mode: "aggregate",
      pipeline: [],
      toFrame: { columns: [{ path: "createdAt" }, { path: "total", name: "Total" }] },
    });
  });

  it("completes stage names and the fields of the collection", async () => {
    const { user } = await open();
    await addStage(user, "$match", "{}");
    const stage = screen.getByRole("textbox", { name: "Stage 1" });
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
