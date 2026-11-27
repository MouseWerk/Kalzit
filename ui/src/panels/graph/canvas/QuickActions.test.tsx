import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import type { GraphSet } from "../../../api/generated/shapes";
import { loadAreas } from "../../../i18n/i18n";
import { buildGraphModel } from "../model";
import { allVisible, buildView } from "../view";
import { QuickBar, QuickSheet, useQuickActions } from "./QuickActions";

const request = vi.hoisted(() => vi.fn());
vi.mock("../../../api/client", async (original) => ({
  ...(await original<typeof import("../../../api/client")>()),
  request,
}));

beforeAll(() => loadAreas("graphStyle", "graphCanvas"));

const GRAPH: GraphSet = {
  nodes: [
    { id: "a", labels: ["Kunde"], properties: { name: "Anna" } },
    { id: "b", labels: ["Kunde"], properties: { name: "Ben" } },
    { id: "c", labels: ["Produkt"], properties: { name: "Abo" } },
  ],
  edges: [
    { id: "e1", type: "KAUFT", from: "a", to: "c", properties: {} },
    { id: "e2", type: "KAUFT", from: "b", to: "c", properties: {} },
  ],
  schema: { labels: ["Kunde", "Produkt"], edgeTypes: ["KAUFT"], propertyKeys: {} },
};

function Canvas({
  chosen,
  orgId,
  onAdopt,
  weights = false,
}: {
  /** Edges carry the number property `menge`. */
  weights?: boolean;
  chosen: string[];
  /** The organization; null for a public page without one. */
  orgId?: string | null;
  onAdopt?: (steps: readonly unknown[]) => void;
}) {
  const graph: GraphSet = weights
    ? { ...GRAPH, edges: GRAPH.edges.map((e) => ({ ...e, properties: { menge: 2 } })) }
    : GRAPH;
  const model = buildGraphModel([graph], { nodeLimit: 100, caption: "name" });
  const view = buildView(model, {
    sizes: new Float32Array(3).fill(10),
    widths: new Float32Array(2).fill(1),
    groups: new Int32Array(3),
    cluster: false,
    open: new Set(),
    clusterCaption: (label) => label,
    unlabelled: "",
  });
  const quick = useQuickActions({
    orgId: orgId === null ? undefined : (orgId ?? "o1"),
    model,
    view,
    visibility: allVisible(view),
    announce: () => undefined,
  });
  if (quick === null) return <p>none</p>;
  return (
    <>
      <QuickBar quick={quick} chosen={chosen} caption={(id) => id} />
      <QuickSheet
        quick={quick}
        model={model}
        onSelect={() => undefined}
        onOnly={() => undefined}
        onAdopt={onAdopt}
      />
      <output data-testid="held">
        {quick.emphasis === null ? "" : [...quick.emphasis.nodes].join(",")}
      </output>
    </>
  );
}

describe("quick actions on the canvas", () => {
  it("find a path between two chosen nodes on the server and hold it up", async () => {
    request.mockResolvedValueOnce({
      results: [
        {
          id: "path",
          ranIn: "server",
          paths: [{ nodes: ["a", "c", "b"], edges: ["e1", "e2"] }],
          summary: {
            key: "analysis.summary.paths",
            values: { paths: 1, edges: 2, from: "Anna", to: "Ben" },
          },
        },
      ],
    });
    const adopted: unknown[] = [];
    const user = userEvent.setup();
    render(<Canvas chosen={["a", "b"]} onAdopt={(steps) => adopted.push(...steps)} />);
    // Weighted needs a number on the edges: shown, with the reason, but not run.
    await user.click(screen.getByRole("button", { name: "Find path" }));
    const weighted = screen.getByRole("button", { name: /Weighted path/ });
    expect(weighted.getAttribute("aria-disabled")).toBe("true");
    expect(within(weighted).getByText("no number on the edges")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Shortest path" }));
    expect(request).toHaveBeenCalledWith(
      "POST",
      "/orgs/o1/graph/actions",
      expect.anything(),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const body = request.mock.calls[0]?.[2] as { steps: unknown[]; graph: GraphSet };
    expect(body.steps[0]).toMatchObject({ type: "paths", from: "a", to: "b", direction: "both" });
    expect(body.graph.nodes).toHaveLength(3);
    expect(
      await screen.findByText(/1 paths, the first with 2 edges from Anna to Ben/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Path 1: Anna › Abo › Ben · 2 edges" })).toBeTruthy();
    expect(screen.getByTestId("held").textContent).toBe("0,1,2");
    await user.click(screen.getByRole("button", { name: "Take over as a step" }));
    expect(adopted[0]).toMatchObject({ type: "paths", mode: "shortest", keepAll: true });
  });

  it("rank the most important nodes, ties sharing a rank, and say an error plainly", async () => {
    request.mockResolvedValueOnce({
      results: [{ id: "top", ranIn: "server", values: { a: 0.3, b: 0.3, c: 0.4 } }],
    });
    const user = userEvent.setup();
    render(<Canvas chosen={[]} />);
    await user.click(screen.getByRole("button", { name: "Most important nodes" }));
    const list = await screen.findByRole("list");
    expect(
      within(list)
        .getAllByRole("listitem")
        .map((li) => li.textContent),
    ).toEqual(["1 Abo 0.4", "2 Anna 0.3", "2 Ben 0.3"]);
    request.mockResolvedValueOnce({
      results: [
        {
          id: "top",
          ranIn: "server",
          error: {
            code: "validation",
            message: "too large",
            reason: "steps.algorithm_too_large",
            params: { nodes: "48210", maxNodes: "20000" },
          },
        },
      ],
    });
    await user.click(screen.getByRole("radio", { name: "Betweenness" }));
    expect(await screen.findByText(/Too large for this step/)).toBeTruthy();
  });

  it("say why when a pair could not be computed, instead of claiming who is apart", async () => {
    request.mockResolvedValueOnce({
      results: [
        {
          id: "pair-0-1",
          ranIn: "server",
          paths: [{ nodes: ["a", "c", "b"], edges: ["e1", "e2"] }],
        },
        {
          id: "pair-0-2",
          ranIn: "server",
          error: {
            code: "validation",
            message: "late",
            reason: "steps.timeout",
            params: { seconds: "30" },
          },
        },
        { id: "pair-1-2", ranIn: "server", paths: [] },
      ],
    });
    const user = userEvent.setup();
    render(<Canvas chosen={["a", "b", "c"]} />);
    await user.click(screen.getByRole("button", { name: "How are these connected?" }));
    expect(await screen.findByText(/^Not every pair could be computed: /)).toBeTruthy();
    expect(screen.queryByText(/Not connected to the others/)).toBeNull();
  });

  it("refuse more than twenty nodes with the reason, without running on a part", async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 21 }, (_, i) => `n${i}`);
    render(<Canvas chosen={many} />);
    const connect = screen.getByRole("button", { name: "How are these connected?" });
    expect(connect.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("At most 20 selected nodes.")).toBeTruthy();
    request.mockClear();
    await user.click(connect);
    expect(request).not.toHaveBeenCalled();
  });

  it("offer a weighted path per number on the edges, swap the ends and close on Escape", async () => {
    request.mockResolvedValue({ results: [{ id: "path", ranIn: "server", paths: [] }] });
    const user = userEvent.setup();
    render(<Canvas chosen={["a", "b"]} weights />);
    const opener = screen.getByRole("button", { name: "Find path" });
    await user.click(opener);
    // Focus moves into the menu.
    expect(document.activeElement?.textContent).toBe("Shortest path");
    expect(screen.getByText("From a to b")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Swap From and To" }));
    expect(screen.getByText("From b to a")).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("button", { name: "Swap From and To" })).toBeNull();
    expect(document.activeElement).toBe(opener);
    await user.click(opener);
    await user.click(screen.getByRole("button", { name: "Weighted path by menge ›" }));
    const body = request.mock.calls.at(-1)?.[2] as { steps: Record<string, unknown>[] };
    expect(body.steps[0]).toMatchObject({ mode: "weighted", weight: "menge", from: "a", to: "b" });
    request.mockReset();
  });

  it("walk the measures with the arrow keys and cap a long list of ties", async () => {
    const tied = Object.fromEntries(Array.from({ length: 14 }, (_, i) => [`x${i}`, 1]));
    request.mockResolvedValue({ results: [{ id: "top", ranIn: "server", values: tied }] });
    const user = userEvent.setup();
    render(<Canvas chosen={[]} />);
    await user.click(screen.getByRole("button", { name: "Most important nodes" }));
    expect(await screen.findByText("and 4 more on the same ranks")).toBeTruthy();
    const pageRank = screen.getByRole("radio", { name: "PageRank" });
    expect(pageRank.getAttribute("tabindex")).toBe("0");
    expect(screen.getByRole("radio", { name: "Degree" }).getAttribute("tabindex")).toBe("-1");
    pageRank.focus();
    await user.keyboard("{ArrowRight}");
    expect(screen.getByRole("radio", { name: "Degree" }).getAttribute("aria-checked")).toBe("true");
    request.mockReset();
  });

  it("drop the question on its way when the measure changes, and ask again once when busy", async () => {
    request.mockReset();
    let first: AbortSignal | undefined;
    // The first question hangs until it is aborted.
    request.mockImplementationOnce(
      (_m: string, _p: string, _b: unknown, options: { signal: AbortSignal }) =>
        new Promise((_, reject) => {
          first = options.signal;
          options.signal.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    );
    // The second is turned away once while the first still holds the place, then answered.
    const busy = new ApiError(
      "busy",
      503,
      "busy",
      undefined,
      {
        error: { code: "busy", message: "busy", reason: "graph_actions.user_busy" },
      },
      10,
    );
    request.mockRejectedValueOnce(busy);
    request.mockResolvedValueOnce({
      results: [{ id: "top", ranIn: "server", values: { a: 3, b: 1, c: 2 } }],
    });
    const user = userEvent.setup();
    render(<Canvas chosen={[]} />);
    await user.click(screen.getByRole("button", { name: "Most important nodes" }));
    await user.click(screen.getByRole("radio", { name: "Degree" }));
    expect(first?.aborted).toBe(true);
    const list = await screen.findByRole("list");
    expect(within(list).getAllByRole("listitem")[0]?.textContent).toContain("Anna");
    expect(request).toHaveBeenCalledTimes(3);
    const asked = request.mock.calls.map(
      (c) => (c[2] as { steps: { type: string }[] }).steps[0]?.type,
    );
    expect(asked).toEqual(["centrality", "degree", "degree"]);
    // Nothing failed in the person's eyes.
    expect(screen.queryByText(/did not come through/)).toBeNull();
    request.mockReset();
  });

  it("are not offered without an organization (public links, snapshots)", () => {
    render(<Canvas chosen={["a", "b"]} orgId={null} />);
    expect(screen.getByText("none")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Find path" })).toBeNull();
  });

  it("say when the whole request failed", async () => {
    request.mockRejectedValueOnce(new Error("offline"));
    const user = userEvent.setup();
    render(<Canvas chosen={["a", "b", "c"]} />);
    await user.click(screen.getByRole("button", { name: "How are these connected?" }));
    await waitFor(() =>
      expect(
        screen.getByText("The analysis did not come through. Try again in a moment."),
      ).toBeTruthy(),
    );
  });
});
