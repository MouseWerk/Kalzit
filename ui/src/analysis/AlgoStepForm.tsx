import { type ReactNode, useId } from "react";
import type { GraphSet, Node } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import {
  ALGO_LIMITS,
  type AlgoStepKind,
  type AlongOp,
  type GraphAggregate,
  type GraphAggregateOp,
  numericEdgeKeys,
  numericNodeKeys,
} from "./algoSteps";
import type { Direction } from "./graphSteps";
import { Checks, Choice, NumberField, Text, withCurrent } from "./stepFields";

/**
 * The forms of the graph algorithm steps (board Graph082, frame 3): the parameters with their
 * defaults, each bounded at the field with the range under it. Defaults fit, so a step computes
 * right after it was added; only the two ends of a path are required.
 */

type Placed<K> = K & { id: string; disabled?: boolean };

/** Nodes a list of choices offers at most; a larger graph takes an id as text. */
const MAX_NODE_CHOICES = 500;
const DIRECTIONS: readonly Direction[] = ["both", "out", "in"];
const AGG_OPS: readonly GraphAggregateOp[] = ["count", "sum", "mean", "min", "max", "distinct"];
const ALONG_OPS: readonly AlongOp[] = ["sum", "mean", "count", "min", "max"];

/** A node as a person knows it: its text property `name`, else its id. */
export function nodeName(node: Node): string {
  const name = node.properties.name;
  return typeof name === "string" && name !== "" ? name : node.id;
}

/** `step` with `key` set to `value`, or without it when `value` is undefined or empty. */
function withField<S>(step: S, key: string, value: unknown): S {
  const { [key]: _, ...rest } = step as Record<string, unknown>;
  const empty = value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
  return (empty ? rest : { ...rest, [key]: value }) as S;
}

function CheckBox({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="checkbox step__wide">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      <span>{label}</span>
    </label>
  );
}

/** A node of the graph, chosen by name; a large graph takes its id as text. */
function NodeChoice({
  label,
  value,
  graph,
  onChange,
}: {
  label: string;
  value: string;
  graph: GraphSet | undefined;
  onChange: (id: string) => void;
}) {
  const nodes = graph?.nodes ?? [];
  if (nodes.length === 0 || nodes.length > MAX_NODE_CHOICES) {
    return <Text label={label} value={value} onChange={onChange} />;
  }
  const options = nodes
    .map((n): [string, string] => [n.id, nodeName(n)])
    .sort((a, b) => a[1].localeCompare(b[1]));
  return <Choice label={label} value={value} options={options} onChange={onChange} />;
}

/** A list of aggregates of merged nodes or edges: what, of which property, under which name. */
function Aggregates({
  legend,
  value,
  keys,
  onChange,
}: {
  legend: string;
  value: readonly GraphAggregate[];
  keys: readonly string[];
  onChange: (next: GraphAggregate[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const set = (i: number, next: GraphAggregate) =>
    onChange(value.map((a, j) => (j === i ? next : a)));
  return (
    <fieldset className="step__checks step__wide algo-aggregates" aria-labelledby={`${id}-legend`}>
      <legend className="field__label" id={`${id}-legend`}>
        {legend}
      </legend>
      {value.map((a, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: aggregates have no identity of their own
        <div className="algo-aggregates__row" key={i}>
          <Choice
            label={t("analysis.algo.aggregateOp")}
            value={a.op}
            options={AGG_OPS.map((op) => [op, t(`analysis.algo.op.${op}`)])}
            onChange={(op) => {
              const next = op as GraphAggregateOp;
              const { property: _, ...rest } = a;
              set(
                i,
                next === "count"
                  ? { ...rest, op: next }
                  : { ...rest, op: next, property: a.property ?? keys[0] ?? "" },
              );
            }}
          />
          {a.op === "count" ? null : (
            <Choice
              label={t("analysis.algo.aggregateProperty")}
              value={a.property ?? ""}
              options={withCurrent(keys, [a.property ?? ""]).map((k) => [k, k])}
              onChange={(property) => set(i, { ...a, property })}
            />
          )}
          <Text
            label={t("analysis.algo.aggregateName")}
            value={a.name}
            onChange={(name) => set(i, { ...a, name })}
          />
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => onChange(value.filter((_, j) => j !== i))}
          >
            {t("analysis.algo.aggregateRemove")}
          </button>
        </div>
      ))}
      {value.length < ALGO_LIMITS.maxProperties ? (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => {
            const taken = new Set(value.map((a) => a.name));
            let name = "count";
            for (let n = 2; taken.has(name); n++) name = `count_${n}`;
            onChange([...value, { op: "count", name }]);
          }}
        >
          {t("analysis.algo.aggregateAdd")}
        </button>
      ) : null}
    </fieldset>
  );
}

export interface AlgoStepFormProps {
  step: Placed<AlgoStepKind>;
  graph: GraphSet | undefined;
  frameChoice: ReactNode;
  onChange: (step: Placed<AlgoStepKind>) => void;
}

export function AlgoStepForm({ step, graph, frameChoice, onChange }: AlgoStepFormProps) {
  const { t } = useI18n();
  const labels = graph?.schema.labels ?? [];
  const types = graph?.schema.edgeTypes ?? [];
  const keys = graph?.schema.propertyKeys ?? {};
  const allKeys = [...new Set(Object.values(keys).flat())].sort();
  const edgeNumbers = numericEdgeKeys(graph);
  const nodeNumbers = numericNodeKeys(graph);
  const set = (key: string, value: unknown) => onChange(withField(step, key, value));
  const range = (min: number, max: number) =>
    t("analysis.algo.range", { min: String(min), max: String(max) });
  const hint = (text: string) => <p className="field__hint step__wide">{text}</p>;

  const direction = (fallback: Direction = "both") => (
    <Choice
      label={t("analysis.graph.direction")}
      value={(step as { direction?: Direction }).direction ?? fallback}
      options={DIRECTIONS.map((d) => [d, t(`analysis.direction.${d}`)])}
      onChange={(d) => set("direction", d === fallback ? undefined : d)}
    />
  );
  const weight = (required = false) => {
    const value = (step as { weight?: string }).weight ?? "";
    return (
      <Choice
        label={t("analysis.algo.weight")}
        value={value}
        options={[
          ...(required ? [] : [["", t("analysis.algo.noWeight")] as [string, string]]),
          ...withCurrent(edgeNumbers, [value]).map((k): [string, string] => [k, k]),
        ]}
        onChange={(w) => set("weight", w)}
      />
    );
  };
  const edgeTypes = () => {
    const value = (step as { edgeTypes?: string[] }).edgeTypes ?? [];
    return types.length === 0 ? null : (
      <Checks
        legend={t("analysis.graph.edgeTypes")}
        options={withCurrent(types, value).map((v) => [v, v])}
        value={value}
        onChange={(next) => set("edgeTypes", next)}
      />
    );
  };
  const labelChoice = () => {
    const value = (step as { label?: string }).label ?? "";
    return (
      <Choice
        label={t("analysis.algo.label")}
        value={value}
        options={[
          ["", t("analysis.graph.allLabels")],
          ...withCurrent(labels, [value]).map((l): [string, string] => [l, l]),
        ]}
        onChange={(l) => set("label", l)}
      />
    );
  };
  const property = (fallback: string, key = "name") => (
    <Text
      label={t("analysis.graph.property")}
      value={((step as unknown as Record<string, unknown>)[key] as string | undefined) ?? fallback}
      onChange={(name) => set(key, name === fallback ? undefined : name)}
    />
  );
  const number = (
    key: string,
    label: string,
    fallback: number,
    min: number,
    max: number,
    decimals = false,
  ) => (
    <NumberField
      label={label}
      value={((step as unknown as Record<string, unknown>)[key] as number | undefined) ?? fallback}
      min={min}
      max={max}
      decimals={decimals}
      hint={range(min, max)}
      onChange={(n) => set(key, n)}
    />
  );
  const place = (
    <Choice
      label={t("analysis.algo.place")}
      value={step.place ?? "auto"}
      options={[
        ["auto", t("analysis.algo.place.auto")],
        ["server", t("analysis.algo.place.server")],
      ]}
      onChange={(p) => set("place", p === "server" ? "server" : undefined)}
    />
  );

  let fields: ReactNode;
  switch (step.type) {
    case "centrality": {
      const iterative = step.measure === "pageRank" || step.measure === "eigenvector";
      fields = (
        <>
          {direction()}
          {iterative ? weight() : null}
          {step.measure === "pageRank" ? (
            <NumberField
              label={t("analysis.algo.damping")}
              value={step.damping ?? 0.85}
              min={0.01}
              max={0.99}
              decimals
              hint={range(0.01, 0.99)}
              onChange={(n) => set("damping", n)}
            />
          ) : null}
          {iterative
            ? number(
                "maxIterations",
                t("analysis.algo.maxIterations"),
                100,
                1,
                ALGO_LIMITS.maxIterations,
              )
            : null}
          {property(step.measure === "pageRank" ? "pagerank" : step.measure)}
          {hint(t(`analysis.algo.fields.centrality.${step.measure}`))}
        </>
      );
      break;
    }
    case "communities": {
      const components =
        step.algorithm === "weaklyConnected" || step.algorithm === "stronglyConnected";
      const modular = step.algorithm === "louvain" || step.algorithm === "leiden";
      fields = (
        <>
          {components ? null : weight()}
          {modular ? (
            <NumberField
              label={t("analysis.algo.resolution")}
              value={step.resolution ?? 1}
              min={0.01}
              max={99}
              decimals
              hint={t("analysis.algo.resolutionHint")}
              onChange={(n) => set("resolution", n)}
            />
          ) : null}
          {step.algorithm === "labelPropagation"
            ? number(
                "maxIterations",
                t("analysis.algo.maxIterations"),
                10,
                1,
                ALGO_LIMITS.maxCommunityIterations,
              )
            : null}
          {components ? null : number("seed", t("analysis.algo.seed"), 42, 0, 2_147_483_647)}
          {property(components ? "component" : "community")}
          {hint(
            t(components ? "analysis.algo.fields.components" : "analysis.algo.fields.communities"),
          )}
        </>
      );
      break;
    }
    case "kCore":
      fields = (
        <>
          <CheckBox
            label={t("analysis.algo.kCoreOnly")}
            checked={step.k !== undefined}
            onChange={(on) => set("k", on ? 2 : undefined)}
          />
          {step.k === undefined ? null : number("k", "k", 2, 1, ALGO_LIMITS.maxCore)}
          {property("core")}
          {hint(t("analysis.algo.fields.kCore"))}
        </>
      );
      break;
    case "triangles":
      fields = (
        <>
          {property("triangles")}
          <Text
            label={t("analysis.algo.clusteringName")}
            value={step.clustering ?? "clustering"}
            onChange={(c) => set("clustering", c === "clustering" ? undefined : c)}
          />
          {hint(t("analysis.algo.fields.triangles"))}
        </>
      );
      break;
    case "similarity": {
      const byProperties = step.measure === "cosine" || step.measure === "knn";
      const output = step.output ?? (step.measure === "knn" ? "edges" : "table");
      fields = (
        <>
          {labelChoice()}
          {byProperties ? (
            <Checks
              legend={t("analysis.algo.properties")}
              options={withCurrent(nodeNumbers, step.properties ?? []).map((k) => [k, k])}
              value={step.properties ?? []}
              onChange={(next) => set("properties", next.slice(0, ALGO_LIMITS.maxProperties))}
            />
          ) : (
            <>
              {edgeTypes()}
              {direction()}
            </>
          )}
          {number("topK", t("analysis.algo.topK"), 10, 1, ALGO_LIMITS.maxTopK)}
          {number("minScore", t("analysis.algo.minScore"), 0, 0, 1_000_000, true)}
          {step.measure === "knn" ? null : (
            <Choice
              label={t("analysis.algo.output")}
              value={output}
              options={[
                ["table", t("analysis.algo.output.table")],
                ["edges", t("analysis.algo.output.edges")],
              ]}
              onChange={(o) => set("output", o === "table" ? undefined : o)}
            />
          )}
          {output === "edges" ? property("SIMILAR") : null}
          {hint(
            t(
              output === "edges"
                ? "analysis.algo.fields.similarEdges"
                : "analysis.algo.fields.similarTable",
            ),
          )}
        </>
      );
      break;
    }
    case "linkPrediction":
      fields = (
        <>
          {labelChoice()}
          {number("topK", t("analysis.algo.topSuggestions"), 50, 1, ALGO_LIMITS.maxSuggestions)}
          {number("minScore", t("analysis.algo.minScore"), 0, 0, 1_000_000, true)}
          {hint(t("analysis.algo.fields.linkPrediction"))}
        </>
      );
      break;
    case "paths":
      fields = (
        <>
          <NodeChoice
            label={t("analysis.algo.from")}
            value={step.from}
            graph={graph}
            onChange={(from) => onChange({ ...step, from })}
          />
          <NodeChoice
            label={t("analysis.algo.to")}
            value={step.to}
            graph={graph}
            onChange={(to) => onChange({ ...step, to })}
          />
          {direction()}
          {step.mode === "weighted" || step.mode === "kShortest"
            ? weight(step.mode === "weighted")
            : null}
          {step.mode === "kShortest" ? number("k", "k", 3, 1, ALGO_LIMITS.maxKPaths) : null}
          {step.mode === "allShortest"
            ? number("maxPaths", t("analysis.algo.maxPaths"), 200, 1, ALGO_LIMITS.maxAllPaths)
            : null}
          {number(
            "maxLength",
            t("analysis.algo.maxLength"),
            step.mode === "kShortest" ? 8 : 30,
            1,
            step.mode === "kShortest" ? ALGO_LIMITS.maxCycleLength : ALGO_LIMITS.maxPathLength,
          )}
          {edgeTypes()}
          <CheckBox
            label={t("analysis.algo.keepAll")}
            checked={step.keepAll === true}
            onChange={(on) => set("keepAll", on ? true : undefined)}
          />
          {property("path_order")}
          {step.from !== "" && step.from === step.to ? (
            <p className="field__hint step__wide steps__error">{t("analysis.algo.sameEnds")}</p>
          ) : null}
          {hint(t("analysis.algo.fields.paths"))}
        </>
      );
      break;
    case "reachable": {
      const nodes = graph?.nodes ?? [];
      fields = (
        <>
          {nodes.length > 0 && nodes.length <= 50 ? (
            <Checks
              legend={t("analysis.algo.startNodes")}
              options={withCurrent(
                nodes.map((n) => n.id),
                step.from,
              ).map((id) => {
                const node = nodes.find((n) => n.id === id);
                return [id, node === undefined ? id : nodeName(node)];
              })}
              value={step.from}
              onChange={(from) =>
                onChange({ ...step, from: from.slice(0, ALGO_LIMITS.maxStartNodes) })
              }
            />
          ) : (
            <NodeChoice
              label={t("analysis.algo.startNode")}
              value={step.from[0] ?? ""}
              graph={graph}
              onChange={(id) => onChange({ ...step, from: id === "" ? [] : [id] })}
            />
          )}
          {number("maxHops", t("analysis.algo.maxHops"), 2, 1, ALGO_LIMITS.maxHops)}
          {direction()}
          {edgeTypes()}
          {property("distance")}
          {hint(t("analysis.algo.fields.reachable"))}
        </>
      );
      break;
    }
    case "bridges":
      fields = (
        <>
          {property("bridge")}
          {hint(t("analysis.algo.fields.bridges"))}
        </>
      );
      break;
    case "articulationPoints":
      fields = (
        <>
          {property("articulation")}
          {hint(t("analysis.algo.fields.articulationPoints"))}
        </>
      );
      break;
    case "cycles":
      fields = (
        <>
          {number("maxLength", t("analysis.algo.maxLength"), 6, 2, ALGO_LIMITS.maxCycleLength)}
          {number("maxCount", t("analysis.algo.maxCount"), 200, 1, ALGO_LIMITS.maxCycles)}
          {direction("out")}
          {property("in_cycle")}
          {hint(t("analysis.algo.fields.cycles"))}
        </>
      );
      break;
    case "mergeNodes":
      fields = (
        <>
          <Choice
            label={t("analysis.algo.mergeBy")}
            value={step.by}
            options={[
              ["label", t("analysis.algo.mergeBy.label")],
              ["property", t("analysis.algo.mergeBy.property")],
            ]}
            onChange={(by) => {
              const { property: _, ...rest } = step;
              onChange(
                by === "property"
                  ? { ...rest, by: "property", property: step.property ?? allKeys[0] ?? "" }
                  : { ...rest, by: "label" },
              );
            }}
          />
          {step.by === "property" ? (
            <Choice
              label={t("analysis.graph.propertyKey")}
              value={step.property ?? ""}
              options={withCurrent(allKeys, [step.property ?? ""]).map((k) => [k, k])}
              onChange={(p) => set("property", p)}
            />
          ) : null}
          <Aggregates
            legend={t("analysis.algo.aggregates")}
            value={step.aggregates ?? []}
            keys={allKeys}
            onChange={(next) => set("aggregates", next)}
          />
          <Aggregates
            legend={t("analysis.algo.edgeAggregates")}
            value={step.edgeAggregates ?? []}
            keys={edgeNumbers}
            onChange={(next) => set("edgeAggregates", next)}
          />
          <CheckBox
            label={t("analysis.algo.loops")}
            checked={step.loops !== false}
            onChange={(on) => set("loops", on ? undefined : false)}
          />
          <CheckBox
            label={t("analysis.algo.mergeTypes")}
            checked={step.mergeTypes === true}
            onChange={(on) => set("mergeTypes", on ? true : undefined)}
          />
          {hint(t("analysis.algo.fields.mergeNodes"))}
        </>
      );
      break;
    case "aggregateAlong": {
      const along = step.along ?? "neighbours";
      const ofEdges = along === "paths" && step.of === "edges";
      const sources = ofEdges ? edgeNumbers : nodeNumbers;
      fields = (
        <>
          <Choice
            label={t("analysis.algo.along")}
            value={along}
            options={[
              ["neighbours", t("analysis.algo.along.neighbours")],
              ["paths", t("analysis.algo.along.paths")],
            ]}
            onChange={(a) => {
              const {
                label: _l,
                edgeTypes: _e,
                direction: _d,
                depth: _p,
                of: _o,
                along: _a,
                ...rest
              } = step;
              onChange(a === "paths" ? { ...rest, along: "paths", of: "nodes" } : rest);
            }}
          />
          {along === "paths" ? (
            <Choice
              label={t("analysis.algo.of")}
              value={step.of ?? "nodes"}
              options={[
                ["nodes", t("analysis.graph.rows.nodes")],
                ["edges", t("analysis.graph.rows.edges")],
              ]}
              onChange={(o) => set("of", o)}
            />
          ) : (
            <>
              {labelChoice()}
              {edgeTypes()}
              {direction("out")}
              {number("depth", t("analysis.algo.depth"), 1, 1, ALGO_LIMITS.maxDepth)}
            </>
          )}
          <Choice
            label={t("analysis.algo.aggregateOp")}
            value={step.op}
            options={ALONG_OPS.map((op) => [op, t(`analysis.algo.op.${op}`)])}
            onChange={(op) => {
              const next = op as AlongOp;
              const { property: _, ...rest } = step;
              onChange(
                next === "count"
                  ? { ...rest, op: next }
                  : { ...rest, op: next, property: step.property ?? sources[0] ?? "" },
              );
            }}
          />
          {step.op === "count" ? null : (
            <Choice
              label={t("analysis.algo.aggregateProperty")}
              value={step.property ?? ""}
              options={withCurrent(sources, [step.property ?? ""]).map((k) => [k, k])}
              onChange={(p) => set("property", p)}
            />
          )}
          <Text
            label={t("analysis.graph.property")}
            value={step.name}
            onChange={(name) => onChange({ ...step, name })}
          />
          {hint(
            t(
              along === "paths"
                ? "analysis.algo.fields.alongPaths"
                : "analysis.algo.fields.alongNeighbours",
            ),
          )}
        </>
      );
      break;
    }
  }
  return (
    <div className="step__form">
      {frameChoice}
      {fields}
      {step.type === "mergeNodes" || step.type === "aggregateAlong" ? null : place}
    </div>
  );
}
