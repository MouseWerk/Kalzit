import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { DocumentSet, FieldDistribution, FieldSchema } from "../api/generated/shapes";
import { PanelBody } from "../features/dashboards/PanelCard";
import { fakeOrders } from "../features/datasources/test/fakeMongo";
import { getPanel } from "../panels/registry";
import type { AnyPanelPlugin, DistributionRunner, DocumentFilter } from "../panels/types";
import { sampleSchema } from "./schema";

const RANGE = { from: 0, to: 100_000 };

function orders(): DocumentSet {
  const documents = fakeOrders();
  return { documents, schema: sampleSchema(documents), notices: [] };
}

function renderPanel(
  type: string,
  documents: DocumentSet[],
  options: unknown = {},
  onFilter?: (filter: DocumentFilter) => void,
) {
  const plugin = getPanel(type) as AnyPanelPlugin;
  const { Panel } = plugin;
  return render(
    <div>
      <Panel
        frames={[]}
        documents={documents}
        options={plugin.options(options)}
        timeRange={RANGE}
        title="Orders"
        onFilter={onFilter}
      />
    </div>,
  );
}

/** The drawn tree rows; a selector, since role queries are slow and these run after each step. */
const treeItems = () => [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];

const rowNames = () => treeItems().map((item) => item.querySelector(".doc-tree__key")?.textContent);

/** The drawn tree row whose key is `name`. */
const treeRow = (name: string) =>
  treeItems().find(
    (item) => item.querySelector(".doc-tree__key")?.textContent === name,
  ) as HTMLElement;

describe("document explorer", () => {
  it("lists documents closed, opens one with the keyboard and shows each value's type", async () => {
    const user = userEvent.setup();
    renderPanel("documents", [orders()]);
    expect(screen.getByText("3 documents.")).toBeTruthy();
    const tree = screen.getByRole("tree", { name: "Orders" });
    expect(rowNames()).toEqual(["Document 1", "Document 2", "Document 3"]);
    expect(treeItems()[0]?.getAttribute("aria-expanded")).toBe("false");

    act(() => tree.focus());
    // Focus on the tree makes the first row the active one.
    expect(tree.getAttribute("aria-activedescendant")).toBe(treeItems()[0]?.id);
    await user.keyboard("{ArrowRight}");
    expect(rowNames().slice(0, 4)).toEqual(["Document 1", "_id", "createdAt", "status"]);
    const row = treeRow;

    expect(within(row("_id")).getByText("ObjectId")).toBeTruthy();
    expect(within(row("createdAt")).getByText("Date")).toBeTruthy();
    expect(within(row("total")).getByText("Decimal128")).toBeTruthy();
    expect(within(row("total")).getByText("129.90")).toBeTruthy();
    // int64 keeps every digit.
    expect(within(row("views")).getByText("Int64")).toBeTruthy();
    expect(within(row("views")).getByText("9,007,199,254,740,993")).toBeTruthy();
    expect(within(row("items")).getByText("2 items")).toBeTruthy();
    expect(row("Document 1").getAttribute("aria-setsize")).toBe("3");
    expect(row("_id").getAttribute("aria-level")).toBe("2");

    // Left on an open row closes it; Left on a child goes to its parent.
    await user.keyboard("{ArrowDown}{ArrowLeft}");
    expect(tree.getAttribute("aria-activedescendant")).toBe(row("Document 1").id);
    await user.keyboard("{ArrowLeft}");
    expect(rowNames()).toEqual(["Document 1", "Document 2", "Document 3"]);
  });

  it("copies the path of a nested value and filters by it", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const onFilter = vi.fn();
    renderPanel("documents", [orders()], {}, onFilter);
    const tree = screen.getByRole("tree", { name: "Orders" });
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("items"));
    await user.click(treeRow("[1]"));
    await user.click(treeRow("sku"));
    expect(document.activeElement).toBe(tree);
    expect(screen.getByText("items.1.sku")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Copy path" }));
    expect(writeText).toHaveBeenCalledWith("items.1.sku");
    expect(screen.getByRole("status").textContent).toBe("Copied items.1.sku");

    await user.click(screen.getByRole("button", { name: "Filter by value" }));
    // The filter path has no array index: it matches any element.
    expect(onFilter).toHaveBeenCalledWith({ index: 0, path: "items.sku", value: "B-2" });
  });

  it("offers no filter where the query cannot change, and none for objects", async () => {
    const user = userEvent.setup();
    renderPanel("documents", [orders()]);
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("status"));
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filter by value" })).toBeNull();
  });

  it("opens a nested array as a list of its own and goes back", async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    renderPanel("documents", [orders()], {}, onFilter);
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("items"));
    await user.click(screen.getByRole("button", { name: "Open as list" }));

    const trail = screen.getByRole("navigation", { name: "Where in the documents" });
    expect(within(trail).getByText("Document 1: items").getAttribute("aria-current")).toBe(
      "location",
    );
    // The elements are the list now, as rows, never as JSON text.
    expect(rowNames()).toEqual(["[0]", "[1]"]);
    await user.click(treeItems()[1] as HTMLElement);
    await user.click(treeRow("price"));
    expect(screen.getByText("items.1.price")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Filter by value" }));
    expect(onFilter).toHaveBeenCalledWith({ index: 0, path: "items.price", value: 90.1 });

    await user.click(within(trail).getByRole("button", { name: "All documents" }));
    expect(rowNames()).toEqual(["Document 1", "Document 2", "Document 3"]);
  });

  it("pages long arrays instead of drawing them whole", async () => {
    const user = userEvent.setup();
    const long = {
      documents: [{ values: Array.from({ length: 250 }, (_, i) => i) }],
      schema: [],
      notices: [],
    };
    renderPanel("documents", [long]);
    const tree = screen.getByRole("tree", { name: "Orders" });
    act(() => tree.focus());
    await user.keyboard("{ArrowRight}{ArrowDown}{ArrowRight}{End}");
    const last = treeItems().at(-1) as HTMLElement;
    expect(last.textContent).toBe("Show 100 more of 150");
    await user.keyboard("{Enter}{End}");
    expect(treeItems().at(-1)?.textContent).toBe("Show 50 more of 50");
  });
});

describe("schema panel", () => {
  const schema: FieldSchema[] = [
    { path: "_id", coverage: 1, types: [{ name: "objectId", share: 1 }] },
    { path: "email", coverage: 0.97, types: [{ name: "string", share: 1 }] },
    {
      path: "age",
      coverage: 1,
      types: [
        { name: "int", share: 0.8 },
        { name: "string", share: 0.2 },
      ],
    },
    { path: "tags[]", coverage: 0.5, types: [{ name: "string", share: 1 }] },
  ];

  it("shows types, coverage and outliers, and narrows to outliers or a search", async () => {
    const user = userEvent.setup();
    renderPanel("schema", [{ documents: [{}, {}], schema, notices: [] }]);
    expect(screen.getByText("Paths: 4 · Documents: 2 · With outliers: 3")).toBeTruthy();
    const cells = (path: string) =>
      within(screen.getByRole("cell", { name: path }).closest("tr") as HTMLElement)
        .getAllByRole("cell")
        .map((cell) => cell.textContent);
    expect(cells("_id")).toEqual(["_id", "ObjectId 100%", "100%", ""]);
    expect(cells("email")).toEqual(["email", "String 100%", "97%", "Missing in 3%"]);
    expect(cells("age")).toEqual(["age", "Int32 80%, String 20%", "100%", "Mixed types"]);

    await user.click(screen.getByRole("checkbox", { name: "Only outliers" }));
    expect(screen.queryByRole("cell", { name: "_id" })).toBeNull();
    fireEvent.change(screen.getByRole("searchbox", { name: "Find paths" }), {
      target: { value: "TAG" },
    });
    expect(screen.getAllByRole("row")).toHaveLength(2);
    expect(screen.getByRole("cell", { name: "tags[]" })).toBeTruthy();
  });

  it("samples the schema itself when the result came without", () => {
    renderPanel("schema", [{ documents: fakeOrders(), schema: [], notices: [] }]);
    expect(screen.getByRole("cell", { name: "customer.address.city" })).toBeTruthy();
    const rating = within(
      screen.getByRole("cell", { name: "rating" }).closest("tr") as HTMLElement,
    );
    expect(rating.getByText("Mixed types")).toBeTruthy();
  });
});

describe("field distribution", () => {
  it("shows counts, range, a histogram and top values for a path inside arrays", async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    renderPanel("distribution", [orders()], { path: "items[].price" }, onFilter);
    const value = (name: string) => screen.getByText(name).nextElementSibling?.textContent;
    expect(value("Values")).toBe("4");
    expect(value("Documents with the field")).toBe("3");
    expect(value("Minimum")).toBe("15");
    expect(value("Maximum")).toBe("90.1");
    expect(
      screen.getByRole("img", {
        name: /^Histogram of items\[\]\.price: 20 bins from 15 to 90\.1$/,
      }),
    ).toBeTruthy();

    await user.selectOptions(screen.getByRole("combobox", { name: "Field path" }), "items[].sku");
    const top = screen
      .getAllByRole("listitem")
      .map((item) => item.querySelector(".dist__value")?.textContent);
    expect(top).toEqual(["A-1", "B-2", "C-3"]);
    expect(screen.queryByRole("img")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Filter by A-1" }));
    expect(onFilter).toHaveBeenCalledWith({ index: 0, path: "items.sku", value: "A-1" });
  });

  it("starts with the first numeric or date field", () => {
    renderPanel("distribution", [orders()]);
    expect(screen.getByRole("combobox", { name: "Field path" })).toHaveProperty(
      "value",
      "createdAt",
    );
    // A source that cannot count in the database: the loaded documents, and it says so.
    expect(screen.getByText("Across the 3 loaded documents")).toBeTruthy();
  });

  it("reads a key with a dot as that key", () => {
    const documents = [{ "preis.netto": 10 }, { preis: { netto: 99 } }, { "preis.netto": 20 }];
    const set: DocumentSet = { documents, schema: sampleSchema(documents), notices: [] };
    renderPanel("distribution", [set], { path: "preis.netto" });
    const value = (name: string) => screen.getByText(name).nextElementSibling?.textContent;
    expect(value("Values")).toBe("2");
    expect(value("Maximum")).toBe("20");
  });
});

describe("field distribution over the whole result", () => {
  const answer = (over: Partial<FieldDistribution> = {}): FieldDistribution => ({
    total: 1200,
    documents: 1150,
    missing: 50,
    values: 1300,
    nulls: 4,
    distinct: 100_000,
    distinctCapped: true,
    types: [{ name: "string", count: 1300 }],
    top: [{ value: "paid", count: 900 }],
    bins: [],
    ...over,
  });

  function renderWhole(run: DistributionRunner, revision: string | number = 1) {
    const plugin = getPanel("distribution") as AnyPanelPlugin;
    const { Panel } = plugin;
    const set = { ...orders(), distributable: true };
    const props = {
      frames: [],
      documents: [set],
      options: plugin.options({ path: "status" }),
      timeRange: RANGE,
      title: "Orders",
      distribution: run,
    };
    const view = render(<Panel {...props} revision={revision} />);
    return {
      ...view,
      rerun: (next: string | number) => view.rerender(<Panel {...props} revision={next} />),
    };
  }

  it("counts in the database and says over how many documents", async () => {
    const run = vi.fn(async () => answer());
    renderWhole(run);
    expect(screen.getByText("Counting all documents of the result in the database…")).toBeTruthy();
    expect(await screen.findByText("Across all 1,200 documents of the result")).toBeTruthy();
    expect(run).toHaveBeenCalledWith(0, { path: ["status"] }, expect.any(AbortSignal));
    const value = (name: string) => screen.getByText(name).nextElementSibling?.textContent;
    expect(value("Values")).toBe("1,300");
    expect(value("Null values")).toBe("4");
    expect(value("Distinct values")).toBe("more than 100,000");
    expect(screen.getByText("900 (69.2%)")).toBeTruthy();
  });

  it("cancels the request of the field it leaves and shows the new one only", async () => {
    const user = userEvent.setup();
    const signals: AbortSignal[] = [];
    const held: ((d: FieldDistribution) => void)[] = [];
    const run = vi.fn(
      (_index: number, _ask: unknown, signal: AbortSignal) =>
        new Promise<FieldDistribution>((resolve) => {
          signals.push(signal);
          held.push(resolve);
        }),
    );
    renderWhole(run);
    await user.selectOptions(screen.getByRole("combobox", { name: "Field path" }), "rating");
    expect(run).toHaveBeenLastCalledWith(0, { path: ["rating"] }, expect.any(AbortSignal));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals.at(-1)?.aborted).toBe(false);
    // The answer for the old field comes too late and is not shown.
    await act(async () => held[0]?.(answer({ total: 7 })));
    expect(screen.queryByText("Across all 7 documents of the result")).toBeNull();
    await act(async () => held.at(-1)?.(answer({ total: 8 })));
    expect(screen.getByText("Across all 8 documents of the result")).toBeTruthy();
  });

  it("falls back to the loaded documents when counting fails, and tries again", async () => {
    const user = userEvent.setup();
    const run = vi.fn<DistributionRunner>().mockRejectedValueOnce(new Error("down"));
    run.mockResolvedValue(answer());
    renderWhole(run);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toMatch(
      /^Counting all documents failed: .+ The numbers are of the loaded documents\./,
    );
    expect(screen.getByText("Across the 3 loaded documents")).toBeTruthy();
    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Across all 1,200 documents of the result")).toBeTruthy();
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("asks again for a new result", async () => {
    const run = vi.fn(async () => answer());
    const { rerun } = renderWhole(run, 1);
    await screen.findByText("Across all 1,200 documents of the result");
    rerun(2);
    await screen.findByText("Across all 1,200 documents of the result");
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("document card", () => {
  it("shows one document readably, titled by a field, and pages through the rest", async () => {
    const user = userEvent.setup();
    renderPanel("document", [orders()], { titlePath: "customer.name" });
    expect(screen.getByRole("heading", { name: "Ada" })).toBeTruthy();
    const card = screen.getByRole("article", { name: "Ada" });
    expect(within(card).getByText("Wien")).toBeTruthy();
    expect(within(card).getByText("A-1")).toBeTruthy();
    expect(within(card).getAllByText("Decimal128")).toHaveLength(1);
    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText("Document 2 of 3")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Grace" })).toBeTruthy();
  });
});

describe("panels and shapes", () => {
  const panel = (type: string, transformations: unknown[] = []) => ({
    id: "p",
    type,
    title: "",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: [{ refId: "A", datasourceId: "ds", query: { collection: "orders", pipeline: "[]" } }],
    transformations,
    options: {},
    fieldConfig: {},
  });
  const outcome = { refId: "A", result: { shape: "documents" as const, documents: orders() } };

  it("asks for a projection step before drawing documents as a table, never converting on its own", () => {
    render(
      <PanelBody
        panel={panel("table")}
        title="T"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[outcome]}
      />,
    );
    expect(screen.getByText(/Add a projection step/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("draws the projected table when the panel has the step for that query", () => {
    render(
      <PanelBody
        panel={panel("table", [
          {
            id: "0199f0a0-1c2e-4a4b-9e1d-3f5a6b7c8d91",
            type: "toFrame",
            frame: "A",
            columns: [{ path: "customer.name", name: "Customer" }, { path: "total" }],
          },
        ])}
        title="T"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[outcome]}
      />,
    );
    expect(screen.getByRole("columnheader", { name: /Customer/ })).toBeTruthy();
    expect(screen.getByText("Grace")).toBeTruthy();
    expect(screen.getByText("129.9")).toBeTruthy();
  });

  it("gives document panels only the documents no projection step turns into a frame", () => {
    const step = (columns: { path: string }[]) => ({
      id: "0199f0a0-1c2e-4a4b-9e1d-3f5a6b7c8d92",
      type: "toFrame",
      frame: "A",
      columns,
    });
    const view = render(
      <PanelBody
        panel={panel("documents", [step([{ path: "total" }])])}
        title="T"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[outcome]}
      />,
    );
    // The projection made a frame of them: the explorer says it got a table, not documents.
    expect(screen.getByText(/the query answered with a table/)).toBeTruthy();
    expect(screen.queryByRole("tree")).toBeNull();
    view.unmount();
    // A step whose columns all still wait for a path projects nothing: the documents show.
    render(
      <PanelBody
        panel={panel("documents", [step([{ path: " " }])])}
        title="T"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[outcome]}
      />,
    );
    expect(screen.getByRole("tree")).toBeTruthy();
  });

  it("says when a document panel gets a table", () => {
    render(
      <PanelBody
        panel={panel("documents")}
        title="T"
        range={RANGE}
        pending={false}
        error={null}
        outcomes={[
          {
            refId: "A",
            result: {
              shape: "frame",
              frame: { fields: [{ name: "n", type: "number", values: [1] }] },
            },
          },
        ]}
      />,
    );
    expect(screen.getByText(/shows documents, and the query answered with a table/)).toBeTruthy();
  });
});

describe("review follow-ups", () => {
  it("pages long arrays in the card instead of drawing them whole", async () => {
    const user = userEvent.setup();
    const values = Array.from({ length: 60 }, (_, i) => `v${i}`);
    renderPanel("document", [{ documents: [{ _id: "a", values }], schema: [], notices: [] }]);
    expect(screen.getByText("v49")).toBeTruthy();
    expect(screen.queryByText("v50")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Show 10 more of 10" }));
    expect(screen.getByText("v59")).toBeTruthy();
  });

  it("starts at the top of a new result, leaving an array drilldown", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("documents") as AnyPanelPlugin;
    const { Panel } = plugin;
    const panel = (documents: DocumentSet) => (
      <Panel frames={[]} documents={[documents]} options={{}} timeRange={RANGE} title="Orders" />
    );
    const view = render(panel(orders()));
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("items"));
    await user.click(screen.getByRole("button", { name: "Open as list" }));
    expect(rowNames()).toEqual(["[0]", "[1]"]);
    view.rerender(panel({ documents: [{ a: 1 }], schema: [], notices: [] }));
    expect(rowNames()).toEqual(["Document 1"]);
    expect(screen.queryByRole("navigation", { name: "Where in the documents" })).toBeNull();
    // One document: the summary speaks of one.
    expect(screen.getByText("1 document.")).toBeTruthy();
  });

  it("offers no filter on keys a filter path cannot name, and explains null", async () => {
    const user = userEvent.setup();
    const onFilter = vi.fn();
    renderPanel(
      "documents",
      [{ documents: [{ "a.b": 1, $kind: "x", gone: null }], schema: [], notices: [] }],
      {},
      onFilter,
    );
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("a.b"));
    expect(screen.getByRole("button", { name: "Copy path" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Filter by value" })).toBeNull();
    await user.click(treeRow("$kind"));
    expect(screen.queryByRole("button", { name: "Filter by value" })).toBeNull();
    await user.click(treeRow("gone"));
    expect(screen.getByRole("button", { name: "Filter by value" })).toBeTruthy();
    expect(
      screen.getByText(/A filter on null also matches documents without this field/),
    ).toBeTruthy();
  });

  it("names the server's type aliases", () => {
    renderPanel("schema", [
      {
        documents: [{}],
        schema: [
          { path: "n", coverage: 1, types: [{ name: "long", share: 1 }] },
          { path: "b", coverage: 1, types: [{ name: "binData", share: 1 }] },
          { path: "j", coverage: 1, types: [{ name: "javascriptWithScope", share: 1 }] },
        ],
        notices: [],
      },
    ]);
    expect(screen.getByText("Int64 100%")).toBeTruthy();
    expect(screen.getByText("Binary 100%")).toBeTruthy();
    expect(screen.getByText("JavaScript with scope 100%")).toBeTruthy();
  });
});

describe("explorer revisions", () => {
  it("starts over when the page says a new result arrived, not when only the object changed", async () => {
    const user = userEvent.setup();
    const plugin = getPanel("documents") as AnyPanelPlugin;
    const { Panel } = plugin;
    const set = orders();
    const panel = (documents: DocumentSet, revision: string) => (
      <Panel
        frames={[]}
        documents={[documents]}
        options={{}}
        timeRange={RANGE}
        title="Orders"
        revision={revision}
      />
    );
    const view = render(panel(set, "1:0"));
    await user.click(treeItems()[0] as HTMLElement);
    await user.click(treeRow("items"));
    await user.click(screen.getByRole("button", { name: "Open as list" }));
    // The same result, rebuilt as a new object (as merging pages does on every render).
    view.rerender(panel({ ...set }, "1:0"));
    expect(rowNames()).toEqual(["[0]", "[1]"]);
    // Another run or page: the drilldown starts over.
    view.rerender(panel({ ...set }, "1:1"));
    expect(rowNames()).toEqual(["Document 1", "Document 2", "Document 3"]);
  });
});

describe("dates beyond what JavaScript can show", () => {
  // The largest int64 as ms: a common "never expires" sentinel.
  const NEVER = "9223372036854775807";
  const set = (): DocumentSet => {
    const documents = [
      { _id: "a", expires: { $type: "date", value: NEVER } },
      { _id: "b", expires: { $type: "date", value: "1790000000000" } },
    ];
    return { documents, schema: sampleSchema(documents), notices: [] };
  };

  it("show their text in the explorer", async () => {
    const user = userEvent.setup();
    renderPanel("documents", [set()]);
    await user.click(treeItems()[0] as HTMLElement);
    expect(screen.getByText(NEVER)).toBeTruthy();
  });

  it("show their text on the card", () => {
    renderPanel("document", [set()]);
    expect(screen.getByText(NEVER)).toBeTruthy();
  });

  it("leave the distribution of the other dates drawn", () => {
    renderPanel("distribution", [set()], { path: "expires" });
    const value = (name: string) => screen.getByText(name).nextElementSibling?.textContent;
    // Only the date JavaScript can show is on the scale.
    expect(value("Minimum")).toBe(value("Maximum"));
    expect(value("Minimum")).toMatch(/\/26,/);
  });
});
