import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSet, Frame, QueryResponse } from "../api/generated/shapes";
import { sampleSchema } from "../documents/schema";
import { MAX_VARIABLE_OPTIONS, optionsFromResponse } from "../features/dashboards/Variables";
import { fakeOrders } from "../features/datasources/test/fakeMongo";
import { type PanelHost, PanelHostContext } from "./host";
import { getPanel } from "./registry";
import type { AnyPanelPlugin } from "./types";
import { variableText } from "./variableClick";

const RANGE = { from: 0, to: 100_000 };
const ORDER_1 = "665f1c2e9b1e4a0001a1b001";

function orders(): DocumentSet {
  const documents = fakeOrders();
  return { documents, schema: sampleSchema(documents), notices: [] };
}

/** A dashboard with the variable `customer`; `accepts` as a custom variable would. */
function host(set: (name: string, value: string) => void, accepts = () => true): PanelHost {
  return { variables: { names: ["customer"], accepts, set } };
}

function renderPanel(
  type: string,
  data: { frames?: Frame[]; documents?: DocumentSet[] },
  options: unknown,
  panelHost: PanelHost,
) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <PanelHostContext value={panelHost}>
      <Panel
        frames={data.frames ?? []}
        documents={data.documents}
        options={plugin.options(options)}
        timeRange={RANGE}
        title="Orders"
      />
    </PanelHostContext>,
  );
}

const treeRow = (name: string) =>
  [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')].find(
    (item) => item.querySelector(".doc-tree__key")?.textContent === name,
  ) as HTMLElement;

describe("variable text", () => {
  it("takes plain values and typed values as their text, nothing else", () => {
    expect(variableText("Ada")).toBe("Ada");
    expect(variableText(42)).toBe("42");
    expect(variableText(false)).toBe("false");
    expect(variableText({ $type: "objectId", value: ORDER_1 })).toBe(ORDER_1);
    expect(variableText({ $type: "int64", value: "9007199254740993" })).toBe("9007199254740993");
    expect(variableText({ $type: "document", value: { a: 1 } })).toBeNull();
    expect(variableText({ a: 1 })).toBeNull();
    expect(variableText([1])).toBeNull();
    expect(variableText(null)).toBeNull();
    expect(variableText(undefined)).toBeNull();
  });
});

describe("document explorer click", () => {
  it("sets the variable to a whole document's _id, or to the clicked value", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel("documents", { documents: [orders()] }, { variable: "$customer" }, host(set));
    await user.click(treeRow("Document 1"));
    expect(set).toHaveBeenLastCalledWith("customer", ORDER_1);
    expect(
      screen.getAllByRole("status").some((s) => s.textContent === `$customer is now ${ORDER_1}`),
    ).toBe(true);
    await user.click(treeRow("status"));
    expect(set).toHaveBeenLastCalledWith("customer", "paid");
    // The bar acts on the active row too, for the keyboard.
    await user.click(screen.getByRole("button", { name: "Set $customer" }));
    expect(set).toHaveBeenCalledTimes(3);
  });

  it("takes the value at the chosen path of the clicked document", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel(
      "documents",
      { documents: [orders()] },
      { variable: "customer", variablePath: "customer.name" },
      host(set),
    );
    await user.click(treeRow("Document 2"));
    expect(set).toHaveBeenLastCalledWith("customer", "Grace");
    await user.click(treeRow("status"));
    expect(set).toHaveBeenLastCalledWith("customer", "Grace");
  });

  it("leaves the variable as it is for a container or a value the variable does not take", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel(
      "documents",
      { documents: [orders()] },
      { variable: "customer" },
      host(set, () => false),
    );
    await user.click(treeRow("Document 1"));
    expect(set).not.toHaveBeenCalled();
    await user.click(treeRow("customer"));
    expect(set).not.toHaveBeenCalled();
    const status = screen.getAllByRole("status").map((s) => s.textContent);
    expect(status).toContain("There is no value here, so $customer stays as it is.");
  });

  it("does nothing outside a dashboard that has the variable", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel("documents", { documents: [orders()] }, { variable: "customer" }, {});
    await user.click(treeRow("Document 1"));
    expect(set).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Set $customer" })).toBeNull();
  });
});

describe("document card click", () => {
  it("sets the variable from the chosen path when any value is clicked", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel(
      "document",
      { documents: [orders()] },
      { variable: "customer", variablePath: "customer.name" },
      host(set),
    );
    await user.click(screen.getByRole("button", { name: "paid" }));
    expect(set).toHaveBeenLastCalledWith("customer", "Ada");
  });

  it("without a path, takes the clicked value", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel("document", { documents: [orders()] }, { variable: "customer" }, host(set));
    await user.click(screen.getByRole("button", { name: "Wien" }));
    expect(set).toHaveBeenLastCalledWith("customer", "Wien");
  });
});

describe("table row click", () => {
  const frame: Frame = {
    fields: [
      { name: "name", type: "string", values: ["Ada", "Grace"] },
      { name: "customer_id", type: "int64", values: ["9007199254740993", "43"] },
    ],
  };

  it("sets the variable from the chosen column, by click on the row or its button", async () => {
    const user = userEvent.setup();
    const set = vi.fn();
    renderPanel(
      "table",
      { frames: [frame] },
      { variable: "customer", variableColumn: "customer_id" },
      host(set),
    );
    const rows = screen.getAllByRole("row");
    await user.click(within(rows[2] as HTMLElement).getByText("Grace"));
    expect(set).toHaveBeenLastCalledWith("customer", "43");
    const button = screen.getByRole("button", { name: "Set $customer to 9007199254740993" });
    button.focus();
    await user.keyboard("{Enter}");
    expect(set).toHaveBeenLastCalledWith("customer", "9007199254740993");
  });

  it("takes the first column without a name, and says when no column has the name", () => {
    const set = vi.fn();
    const first = renderPanel("table", { frames: [frame] }, { variable: "customer" }, host(set));
    expect(screen.getByRole("button", { name: "Set $customer to Ada" })).toBeTruthy();
    first.unmount();
    renderPanel(
      "table",
      { frames: [frame] },
      { variable: "customer", variableColumn: "gone" },
      host(set),
    );
    expect(
      screen.getByText("No column is called gone, so a click on a row sets nothing."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Set \$customer/ })).toBeNull();
  });
});

describe("click options in the editors", () => {
  it("offers the dashboard's variables and stores the chosen one with its column", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const plugin = getPanel("table") as AnyPanelPlugin;
    const { Editor } = plugin;
    const view = render(
      <PanelHostContext value={host(vi.fn())}>
        <Editor options={plugin.options({})} onChange={onChange} />
      </PanelHostContext>,
    );
    await user.selectOptions(screen.getByLabelText("Clicking a row sets"), "customer");
    expect(onChange).toHaveBeenLastCalledWith(expect.objectContaining({ variable: "customer" }));
    view.rerender(
      <PanelHostContext value={host(vi.fn())}>
        <Editor options={plugin.options({ variable: "customer" })} onChange={onChange} />
      </PanelHostContext>,
    );
    await user.type(screen.getByLabelText("Column for the variable (optional)"), "id");
    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ variable: "customer", variableColumn: "id" }),
    );
  });

  it("shows a value changed from outside, such as an undo", () => {
    const plugin = getPanel("documents") as AnyPanelPlugin;
    const { Editor } = plugin;
    const at = (variablePath: string) => (
      <PanelHostContext value={host(vi.fn())}>
        <Editor
          options={plugin.options({ variable: "customer", variablePath })}
          onChange={vi.fn()}
        />
      </PanelHostContext>
    );
    const view = render(at("customer.id"));
    const input = screen.getByLabelText(
      "Field path for the variable (optional)",
    ) as HTMLInputElement;
    expect(input.value).toBe("customer.id");
    view.rerender(at(""));
    expect(input.value).toBe("");
  });

  it("says when the dashboard has no variables", () => {
    const plugin = getPanel("documents") as AnyPanelPlugin;
    const { Editor } = plugin;
    render(<Editor options={plugin.options({})} onChange={vi.fn()} />);
    expect(
      screen.getByText("The dashboard has no variables yet. Add one in the dashboard settings."),
    ).toBeTruthy();
  });
});

describe("query variable options from other shapes", () => {
  const response = (result: unknown): QueryResponse =>
    ({ results: { A: { result } } }) as unknown as QueryResponse;

  it("reads node and edge properties only through valuesFrom", () => {
    const graph = {
      shape: "graph",
      graph: {
        nodes: [
          {
            id: "n1",
            labels: ["Customer"],
            properties: { cid: { $type: "int64", value: "7" }, name: "Ada" },
          },
          { id: "n2", labels: ["Customer"], properties: { cid: 7, name: "Doppelt" } },
          { id: "n3", labels: ["Product"], properties: { cid: 9 } },
        ],
        edges: [{ id: "e1", type: "BOUGHT", from: "n1", to: "n3", properties: { since: 2020 } }],
        schema: { labels: [], edgeTypes: [] },
      },
    };
    expect(optionsFromResponse(response(graph)).options).toEqual([]);
    expect(
      optionsFromResponse(response(graph), {
        from: "nodes",
        label: "Customer",
        value: "cid",
        text: "name",
      }).options,
    ).toEqual([{ value: "7", label: "Ada" }]);
    expect(
      optionsFromResponse(response(graph), { from: "nodes" }).options.map((o) => o.value),
    ).toEqual(["n1", "n2", "n3"]);
    expect(optionsFromResponse(response(graph), { from: "edges", value: "since" }).options).toEqual(
      [{ value: "2020", label: "2020" }],
    );
  });

  it("reads a document field path, one option per list entry", () => {
    const documents = { shape: "documents", documents: orders() };
    expect(
      optionsFromResponse(response(documents), {
        from: "documents",
        value: "customer.name",
        text: "status",
      }).options.slice(0, 2),
    ).toEqual([
      { value: "Ada", label: "paid" },
      { value: "Grace", label: "open" },
    ]);
    expect(
      optionsFromResponse(response(documents), { from: "documents", value: "tags" }).options.map(
        (o) => o.value,
      ),
    ).toEqual(expect.arrayContaining(["new", "eu"]));
    expect(optionsFromResponse(response(documents)).options).toEqual([]);
  });

  it("keeps at most as many options as the server and says when the list was cut", () => {
    const many = Array.from({ length: MAX_VARIABLE_OPTIONS + 5 }, (_, i) => ({ id: i }));
    const documents = {
      shape: "documents",
      documents: { documents: many, schema: [], notices: [] },
    };
    const cut = optionsFromResponse(response(documents), { from: "documents", value: "id" });
    expect([cut.options.length, cut.truncated]).toEqual([MAX_VARIABLE_OPTIONS, true]);
    const more = {
      shape: "documents",
      documents: { documents: [{ id: 1 }], schema: [], notices: [], nextCursor: "next" },
    };
    expect(optionsFromResponse(response(more), { from: "documents", value: "id" }).truncated).toBe(
      true,
    );
    const frame = {
      shape: "frame",
      frame: { fields: [{ name: "v", type: "string", values: ["a", "a", "b"] }] },
    };
    expect(optionsFromResponse(response(frame))).toEqual({
      options: [
        { value: "a", label: "a" },
        { value: "b", label: "b" },
      ],
      truncated: false,
    });
  });
});
