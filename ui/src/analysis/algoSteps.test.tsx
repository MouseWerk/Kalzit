import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { GraphSet } from "../api/generated/shapes";
import { loadArea, translate } from "../i18n/i18n";
import { pickOption } from "../test/select";
import { addStep, catalogOption, openCatalog } from "../test/stepCatalog";
import {
  algoStepComplete,
  GRAPH_GROUPS,
  GRAPH_VARIANTS,
  graphWords,
  newAlgoStep,
  plannedPlace,
  variantOf,
} from "./algoSteps";
import { placeReason, summaryNumber, summarySentence } from "./algoText";
import { StepsEditor } from "./StepsEditor";
import { type NamedInput, runSteps, type ServerStep, type Step, type StepsRun } from "./steps";

/** Two customers who bought the same product, with a number on each edge. */
const GRAPH: GraphSet = {
  nodes: [
    { id: "k1", labels: ["Kunde"], properties: { name: "Anna", umsatz: 10 } },
    { id: "k2", labels: ["Kunde"], properties: { name: "Ben", umsatz: 4 } },
    { id: "p1", labels: ["Produkt"], properties: { name: "Abo", preis: 9 } },
  ],
  edges: [
    { id: "e1", type: "KAUFTE", from: "k1", to: "p1", properties: { menge: 2 } },
    { id: "e2", type: "KAUFTE", from: "k2", to: "p1", properties: { menge: 1 } },
  ],
  schema: {
    labels: ["Kunde", "Produkt"],
    edgeTypes: ["KAUFTE"],
    propertyKeys: { Kunde: ["name", "umsatz"], Produkt: ["name", "preis"] },
  },
};

const INPUTS: NamedInput[] = [{ name: "A", graph: GRAPH }];

// The algorithm steps' words and forms come with their deferred area, as on the page.
beforeAll(async () => {
  await loadArea("graphSteps");
  graphWords.current = (await import("./graphCatalog")).GRAPH_WORDS;
});
const en = (key: string, params?: Record<string, string>) => translate("en", key as never, params);
const de = (key: string, params?: Record<string, string>) => translate("de", key as never, params);

describe("the catalog's graph steps", () => {
  it("has thirty algorithm entries in seven groups, and the steps from before under one more", () => {
    const algorithms = GRAPH_VARIANTS.filter((v) => v.group !== "basic");
    expect(algorithms).toHaveLength(30);
    expect(new Set(algorithms.map((v) => v.group)).size).toBe(7);
    expect(GRAPH_GROUPS.at(-1)).toBe("basic");
    expect(new Set(GRAPH_VARIANTS.map((v) => v.key)).size).toBe(GRAPH_VARIANTS.length);
    for (const v of GRAPH_VARIANTS) {
      const key = v.type === "degree" || v.group === "basic" ? "analysis" : "graphSteps";
      expect(en(`${key}.kind.${v.key}`), v.key).not.toBe(`${key}.kind.${v.key}`);
    }
  });

  it("finds the entry of a stored step by its measure or mode", () => {
    expect(variantOf({ type: "centrality", measure: "betweenness" })?.key).toBe(
      "centrality.betweenness",
    );
    expect(variantOf({ type: "paths", mode: "kShortest", k: 7 })?.key).toBe("paths.kShortest");
    expect(variantOf({ type: "similarity", measure: "knn", output: "table" })?.key).toBe(
      "similarity.knn",
    );
    expect(variantOf({ type: "cycles" })?.key).toBe("cycles");
  });

  it("says where a step computes with the chosen source", () => {
    const pageRank = variantOf({ type: "centrality", measure: "pageRank" });
    const closeness = variantOf({ type: "centrality", measure: "closeness" });
    const cycles = variantOf({ type: "cycles" });
    if (pageRank === undefined || closeness === undefined || cycles === undefined) throw 0;
    expect(plannedPlace(pageRank, "neo4j")).toBe("neo4j");
    expect(plannedPlace(pageRank, "memgraph")).toBe("memgraph");
    expect(plannedPlace(closeness, "memgraph")).toBeUndefined();
    expect(plannedPlace(cycles, "neo4j")).toBeUndefined();
    expect(plannedPlace(pageRank, "postgres")).toBeUndefined();
  });

  it("fills new steps in so they compute at once, paths between the first two nodes", () => {
    const at = (key: string) => GRAPH_VARIANTS.find((v) => v.key === key);
    const path = newAlgoStep(at("paths.weighted") as never, "A", GRAPH);
    expect(path).toMatchObject({
      type: "paths",
      mode: "weighted",
      from: "k1",
      to: "k2",
      weight: "menge",
    });
    expect(algoStepComplete(path)).toBe(true);
    const cosine = newAlgoStep(at("similarity.cosine") as never, "A", GRAPH);
    expect(cosine).toMatchObject({ measure: "cosine", properties: ["preis", "umsatz"] });
    const along = newAlgoStep(at("aggregateAlong") as never, "A", GRAPH);
    expect(along).toMatchObject({
      label: "Kunde",
      op: "sum",
      property: "preis",
      name: "sum_preis",
    });
    expect(
      algoStepComplete({ type: "paths", frame: "A", mode: "shortest", from: "k1", to: "k1" }),
    ).toBe(false);
    expect(algoStepComplete({ type: "reachable", frame: "A", from: [] })).toBe(false);
    expect(algoStepComplete({ type: "mergeNodes", frame: "A", by: "property" })).toBe(false);
  });
});

describe("the words of an algorithm step", () => {
  it("formats the summary's numbers for the language", () => {
    const summary = {
      key: "analysis.summary.communities",
      values: { count: 3, modularity: 0.30412, largest: 5, smallest: 5 },
    };
    expect(summarySentence(de as never, "de", summary)).toBe(
      "3 Communities, Modularität 0,304. Die größte hat 5 Knoten.",
    );
    expect(summarySentence(en as never, "en", summary)).toBe(
      "3 communities, modularity 0.304. The largest has 5 nodes.",
    );
    expect(summaryNumber(48210, "de")).toBe("48.210");
    expect(
      summarySentence(en as never, "en", { key: "analysis.summary.newer", values: {} }),
    ).toBeNull();
  });

  it("says when a list was cut, and when all values are the same", () => {
    expect(
      summarySentence(en as never, "en", {
        key: "analysis.summary.cycles",
        values: { count: 200, cut: true, maxCount: 200, maxLength: 8 },
      }),
    ).toBe("200 of at least 200 cycles. Reason: at most 200.");
    expect(
      summarySentence(en as never, "en", {
        key: "analysis.summary.centrality",
        values: { nodes: 3, allSame: true },
      }),
    ).toBe("3 nodes scored. All nodes have the same value.");
    expect(placeReason(en as never, "algorithm.not_cancellable")).toContain("cannot stop");
    expect(placeReason(en as never, "algorithm.unknown")).toBeNull();
  });
});

function Harness({ initial, run }: { initial: Step[]; run?: StepsRun }) {
  const [steps, setSteps] = useState(initial);
  const [rules, setRules] = useState<string[]>([]);
  return (
    <>
      <StepsEditor
        steps={steps}
        onChange={setSteps}
        refIds={["A"]}
        inputs={INPUTS}
        run={run}
        kindOf={() => "neo4j"}
        onUseResult={(use, property) => setRules([...rules, `${use}:${property}`])}
      />
      <output data-testid="steps">{JSON.stringify(steps)}</output>
      <output data-testid="rules">{rules.join(",")}</output>
    </>
  );
}

const stored = () => JSON.parse(screen.getByTestId("steps").textContent ?? "[]") as Step[];

describe("algorithm steps in the steps editor", () => {
  it("adds PageRank from the catalog with its group, its place and its defaults", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    const dialog = await openCatalog(user);
    expect(within(dialog).getByText("Centrality · 6")).toBeTruthy();
    expect(within(dialog).getByText("Link prediction · 3")).toBeTruthy();
    // The place shows next to the name; link prediction always runs on the server.
    expect(within(catalogOption(dialog, "PageRank")).getByText("Neo4j")).toBeTruthy();
    expect(within(catalogOption(dialog, "Adamic-Adar")).getByText("Runs on the server")).toBeTruthy();
    await user.keyboard("{Escape}");
    await addStep(user, "PageRank");
    expect(stored()[0]).toMatchObject({ type: "centrality", measure: "pageRank", frame: "A" });
    const card = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(card).getByText("Runs in Neo4j (GDS)")).toBeTruthy();
    expect(within(card).getByText("Computing…")).toBeTruthy();
    await pickOption(user, within(card).getByLabelText("Place"), "Always on the server");
    expect(stored()[0]).toMatchObject({ place: "server" });
  });

  it("finds steps by the question they answer", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    const dialog = await openCatalog(user);
    await user.type(within(dialog).getByRole("searchbox"), "loop");
    const names = within(dialog)
      .getAllByRole("option")
      .map((o) => o.querySelector(".step-catalog__name")?.textContent);
    expect(names).toContain("Cycles");
  });

  it("shows the server's sentence, why it computed there, and the uses of the result", async () => {
    const user = userEvent.setup();
    const step: Step = { id: "s", type: "centrality", frame: "A", measure: "pageRank" };
    const ran = new Map<string, ServerStep>([
      [
        "s",
        {
          ranIn: "server",
          reason: "algorithm.no_library",
          summary: {
            key: "analysis.summary.centrality",
            values: { nodes: 3, top: "Abo", max: 0.4123, measure: "pageRank" },
          },
        },
      ],
    ]);
    const run = runSteps([step], INPUTS, {
      server: { ran, results: new Map(INPUTS.map((i) => [i.name, i])) },
    });
    render(<Harness initial={[step]} run={run} />);
    const card = screen.getByRole("listitem", { name: "Step 1" });
    expect(within(card).getByText("3 nodes scored. Highest value: Abo (0.412).")).toBeTruthy();
    expect(within(card).getByText(/the database has no library for this step/)).toBeTruthy();
    expect(within(card).getByText("Runs on the server")).toBeTruthy();
    await user.click(within(card).getByRole("button", { name: "Show as size" }));
    expect(screen.getByTestId("rules").textContent).toBe("size:pagerank");
  });

  it("offers the server when the database's answer could not be read, a filter when too large", async () => {
    const user = userEvent.setup();
    const step: Step = { id: "s", type: "centrality", frame: "A", measure: "betweenness" };
    const failed = (reason: string, params: Record<string, string>): StepsRun =>
      runSteps([step], INPUTS, {
        server: {
          ran: new Map([
            [
              "s",
              { ranIn: "database", error: { code: "validation", message: "x", reason, params } },
            ],
          ]),
        },
      });
    const { unmount } = render(
      <Harness initial={[step]} run={failed("steps.algorithm_answer", {})} />,
    );
    await user.click(screen.getByRole("button", { name: "Compute on the server" }));
    expect(stored()[0]).toMatchObject({ place: "server" });
    unmount();
    render(
      <Harness
        initial={[step]}
        run={failed("steps.algorithm_too_large", { nodes: "48210", maxNodes: "20000" })}
      />,
    );
    expect(screen.getByText(/Too large for this step/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Insert a filter before" }));
    expect(stored().map((s) => s.type)).toEqual(["filterGraph", "centrality"]);
  });

  it("asks for the two ends of a path and refuses the same node twice", async () => {
    const user = userEvent.setup();
    render(<Harness initial={[]} />);
    await addStep(user, "Shortest path");
    const card = screen.getByRole("listitem", { name: "Step 1" });
    await pickOption(user, within(card).getByLabelText("To"), "Anna");
    expect(within(card).getByText("From and To must be two different nodes.")).toBeTruthy();
    await pickOption(user, within(card).getByLabelText("To"), "Abo");
    expect(stored()[0]).toMatchObject({ from: "k1", to: "p1" });
  });
});

describe("the steps run, waiting for the server", () => {
  it("passes the graph on unchanged until the server answered", () => {
    const step: Step = { id: "s", type: "communities", frame: "A", algorithm: "louvain" };
    const run = runSteps([step], INPUTS);
    expect(run.failed).toBeUndefined();
    expect(run.steps[0]?.waiting).toBe(true);
    expect(run.graphs[0]?.graph).toBe(GRAPH);
    vi.restoreAllMocks();
  });
});
