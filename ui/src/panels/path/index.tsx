import { useId } from "react";
import { isRecord } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { propertyText } from "../graph/adapter";
import { VariableOptions } from "../graph/GraphEditor";
import { buildGraphModel, type GraphModel } from "../graph/model";
import { MAX_NODE_LIMIT } from "../graph/options";
import { usePanelHost } from "../host";
import type { PanelEditorProps, PanelPlugin, PanelProps } from "../types";
import "../graph/graph.css";
import "../panels.css";

export interface PathOptions {
  caption: string;
  variable: string;
  variableProperty: string;
}

/** Paths shown at most; a query returning more is better narrowed than scrolled. */
export const MAX_PATHS = 200;

function parseOptions(stored: unknown): PathOptions {
  const value = isRecord(stored) ? stored : {};
  const text = (v: unknown) => (typeof v === "string" ? v.trim().slice(0, 100) : "");
  return {
    caption: text(value.caption),
    variable: text(value.variable).replace(/^\$/, ""),
    variableProperty: text(value.variableProperty),
  };
}

export interface PathStep {
  kind: "node" | "edge";
  key: string;
  text: string;
  /** Node: its labels. Edge: whether it points along the path. */
  labels?: string[];
  forward?: boolean;
  /** Node: its model index, for setting a variable; -1 when it was not in the result. */
  node?: number;
}

/**
 * A path as the alternating sequence node, edge, node. Each edge's direction is read against the
 * path's order, so a path walked against an edge shows it pointing back.
 */
export function pathSteps(model: GraphModel, path: { nodes: string[]; edges: string[] }) {
  const edgeById = new Map(model.edges.map((edge) => [edge.id, edge]));
  const steps: PathStep[] = [];
  path.nodes.forEach((id, i) => {
    const at = model.index.get(id);
    const node = at === undefined ? undefined : model.nodes[at];
    steps.push({
      kind: "node",
      key: `n${i}`,
      text: node?.caption ?? id,
      labels: node?.labels ?? [],
      node: at ?? -1,
    });
    const edgeId = path.edges[i];
    if (edgeId !== undefined && i < path.nodes.length - 1) {
      const edge = edgeById.get(edgeId);
      const from = edge === undefined ? undefined : model.nodes[edge.source]?.id;
      steps.push({
        kind: "edge",
        key: `e${i}`,
        text: edge?.type ?? edgeId,
        forward: from === undefined || from === id,
      });
    }
  });
  return steps;
}

function PathPanel({ graphs = [], options, title }: PanelProps<PathOptions>) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const number = new Intl.NumberFormat(language);
  const model = buildGraphModel(
    graphs.map((g) => g.graph),
    { nodeLimit: MAX_NODE_LIMIT, caption: options.caption },
  );
  if (model.paths.length === 0) {
    return <p className="panel-empty">{t("graph.path.none")}</p>;
  }
  const variable =
    options.variable !== "" && host.variables?.names.includes(options.variable) === true
      ? options.variable
      : null;
  const setVariable = (index: number) => {
    const node = model.nodes[index];
    if (variable === null || node === undefined || host.variables === undefined) return;
    host.variables.set(
      variable,
      options.variableProperty === ""
        ? node.id
        : propertyText(node.properties[options.variableProperty]),
    );
  };
  const shown = model.paths.slice(0, MAX_PATHS);
  return (
    <div className="graph">
      {model.paths.length > MAX_PATHS ? (
        <p className="graph__note">
          {t("graph.path.cut", {
            shown: number.format(MAX_PATHS),
            count: number.format(model.paths.length),
          })}
        </p>
      ) : null}
      <ol className="paths" aria-label={title}>
        {shown.map((path, p) => {
          const steps = pathSteps(model, path);
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: paths keep the order of the result
            <li key={p}>
              <h3 className="paths__title">
                {t("graph.path.title", {
                  number: number.format(p + 1),
                  count: number.format(path.edges.length),
                })}
              </h3>
              <ol className="path">
                {steps.map((step) =>
                  step.kind === "node" ? (
                    <li key={step.key} className="path__node">
                      {variable !== null && (step.node ?? -1) >= 0 ? (
                        <button
                          type="button"
                          className="path__pick"
                          title={t("graph.variable.set", { name: variable })}
                          onClick={() => setVariable(step.node as number)}
                        >
                          {step.text}
                        </button>
                      ) : (
                        <span>{step.text}</span>
                      )}
                      {step.labels !== undefined && step.labels.length > 0 ? (
                        <span className="path__node-label">{step.labels.join(", ")}</span>
                      ) : null}
                    </li>
                  ) : (
                    <li key={step.key} className="path__edge">
                      <span aria-hidden="true">{step.forward ? "–" : "←"}</span>
                      {step.text}
                      <span aria-hidden="true">{step.forward ? "→" : "–"}</span>
                      <span className="visually-hidden">
                        {step.forward ? t("graph.path.forward") : t("graph.path.backward")}
                      </span>
                    </li>
                  ),
                )}
              </ol>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function PathEditor({ options, onChange }: PanelEditorProps<PathOptions>) {
  const { t } = useI18n();
  const host = usePanelHost();
  const captionId = useId();
  const variableId = useId();
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={captionId}>
          {t("graph.options.caption")}
        </label>
        <p className="field__hint" id={`${captionId}-hint`}>
          {t("graph.options.captionHint")}
        </p>
        <input
          id={captionId}
          className="input input--mono"
          defaultValue={options.caption}
          maxLength={100}
          aria-describedby={`${captionId}-hint`}
          onChange={(event) => onChange({ ...options, caption: event.currentTarget.value })}
        />
      </div>
      <VariableOptions
        id={variableId}
        names={host.variables?.names ?? []}
        options={options}
        onChange={(patch) => onChange({ ...options, ...patch })}
      />
    </>
  );
}

/** Shortest paths and other paths as readable sequences (docs/PLAN.md, "Pfad-Panel"). */
export const pathPanel: PanelPlugin<PathOptions> = {
  type: "path",
  name: "graph.panels.path",
  shapes: ["graph"],
  options: parseOptions,
  Panel: PathPanel,
  Editor: PathEditor,
};
