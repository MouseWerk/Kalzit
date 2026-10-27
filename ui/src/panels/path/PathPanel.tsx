import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { propertyText } from "../graph/adapter";
import { VariableOptions } from "../graph/GraphEditor";
import { buildGraphModel, type GraphModel } from "../graph/model";
import { MAX_NODE_LIMIT } from "../graph/options";
import { isMultiVariable, setVariableFromClick, usePanelHost } from "../host";
import type { PanelEditorProps, PanelProps } from "../types";
import { type PathOptions, parsePathOptions } from "./index";
import "../graph/graph.css";
import "../panels.css";

/** The path panel's components, loaded with its first use (lazy.tsx). */

/** Paths shown at most; a query returning more is better narrowed than scrolled. */
export const MAX_PATHS = 50;
/** Properties a node of a path shows besides its name. */
const NODE_PROPERTIES = 2;

export interface PathStep {
  kind: "node" | "edge";
  key: string;
  text: string;
  /** Node: its labels. Edge: whether it points along the path. */
  labels?: string[];
  forward?: boolean;
  /** Node: its model index, for setting a variable; -1 when it was not in the result. */
  node?: number;
  /** Its properties as "key value" texts: a node's first two besides its name, an edge's all. */
  details?: string[];
}

function details(properties: Record<string, unknown>, skip: string, max: number): string[] {
  return Object.entries(properties)
    .map(([key, value]) => ({ key, text: propertyText(value) }))
    .filter(({ text }) => text !== "" && text !== skip)
    .slice(0, max)
    .map(({ key, text }) => `${key} ${text}`);
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
      details: node === undefined ? [] : details(node.properties, node.caption, NODE_PROPERTIES),
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
        details: edge === undefined ? [] : details(edge.properties, "", Number.POSITIVE_INFINITY),
      });
    }
  });
  return steps;
}

export function PathPanel({ graphs = [], options, title }: PanelProps<PathOptions>) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const [announcement, setAnnouncement] = useState("");
  const [asTable, setAsTable] = useState(false);
  const number = new Intl.NumberFormat(language);
  const model = buildGraphModel(
    graphs.map((g) => g.graph),
    { nodeLimit: MAX_NODE_LIMIT, caption: options.caption },
  );
  if (model.paths.length === 0) {
    return <p className="panel-empty">{t("graph.path.none")}</p>;
  }
  const variable =
    options.variable !== "" &&
    (host.variables?.names.includes(options.variable) === true ||
      isMultiVariable(host, options.variable))
      ? options.variable
      : null;
  const setVariable = (index: number) => {
    const node = model.nodes[index];
    if (variable === null || node === undefined) return;
    const value =
      options.variableProperty === ""
        ? node.id
        : propertyText(node.properties[options.variableProperty]);
    const outcome = setVariableFromClick(host, variable, value);
    setAnnouncement(
      outcome === "set"
        ? t("graph.announce.variable", { name: variable, value })
        : t("graph.announce.variableRefused", { name: variable, value }),
    );
  };
  const shown = model.paths.slice(0, MAX_PATHS);
  const all = shown.map((path) => ({ path, steps: pathSteps(model, path) }));
  const chain = (steps: PathStep[]) =>
    steps.flatMap((s) => (s.kind === "node" ? [s.text] : [])).join(" → ");
  return (
    <div className="graph">
      {/* biome-ignore lint/a11y/useSemanticElements: a group of buttons, not a field set */}
      <div className="graph__toolbar" role="group" aria-label={t("graph.toolbar", { title })}>
        <button
          type="button"
          className="button button--ghost button--small"
          aria-pressed={asTable}
          onClick={() => setAsTable(!asTable)}
        >
          {t("graph.path.asTable")}
        </button>
      </div>
      {model.paths.length > MAX_PATHS ? (
        <p className="graph__note">
          {t("graph.path.cut", {
            shown: number.format(MAX_PATHS),
            count: number.format(model.paths.length),
          })}
        </p>
      ) : null}
      {asTable ? (
        <div className="graph-table">
          <table className="graph-table__table">
            <caption className="graph-table__caption">
              {t("graph.path.table", { title, count: number.format(shown.length) })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t("graph.path.column.path")}</th>
                <th scope="col">{t("graph.path.column.steps")}</th>
                <th scope="col">{t("graph.path.column.chain")}</th>
              </tr>
            </thead>
            <tbody>
              {all.map(({ path, steps }, p) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: paths keep the order of the result
                <tr key={p}>
                  <th scope="row" className="graph-table__number">
                    {number.format(p + 1)}
                  </th>
                  <td className="graph-table__number">{number.format(path.edges.length)}</td>
                  <td>{chain(steps)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ol className="paths" aria-label={title}>
          {all.map(({ path, steps }, p) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: paths keep the order of the result
            <li key={p}>
              {/* The first path is open; the others show their chain until opened. */}
              <details className="paths__path" open={p === 0}>
                <summary className="paths__summary">
                  <h3 className="paths__title">
                    {t("graph.path.title", {
                      number: number.format(p + 1),
                      count: number.format(path.edges.length),
                    })}
                  </h3>
                  <span className="paths__chain">{chain(steps)}</span>
                </summary>
                <ol className="path">
                  {steps.map((step) =>
                    step.kind === "node" ? (
                      <li key={step.key} className="path__node">
                        <span className="path__caption">{step.text}</span>
                        {step.labels !== undefined && step.labels.length > 0 ? (
                          <span className="path__node-label">{step.labels.join(", ")}</span>
                        ) : null}
                        {variable !== null && (step.node ?? -1) >= 0 ? (
                          <button
                            type="button"
                            className="button button--ghost button--small path__pick"
                            aria-label={t("graph.variable.setTo", {
                              name: variable,
                              node: step.text,
                            })}
                            onClick={() => setVariable(step.node as number)}
                          >
                            {t("graph.variable.set", { name: variable })}
                          </button>
                        ) : null}
                        {step.details === undefined || step.details.length === 0 ? null : (
                          <span className="path__details">{step.details.join(" · ")}</span>
                        )}
                      </li>
                    ) : (
                      <li key={step.key} className="path__edge">
                        <span aria-hidden="true">{step.forward ? "↓" : "↑"}</span>{" "}
                        <span className="path__type">{step.text}</span>{" "}
                        <span className="visually-hidden">
                          {step.forward ? t("graph.path.forward") : t("graph.path.backward")}
                        </span>
                        {step.details === undefined || step.details.length === 0 ? null : (
                          <span className="path__details"> {step.details.join(" · ")}</span>
                        )}
                      </li>
                    ),
                  )}
                </ol>
              </details>
            </li>
          ))}
        </ol>
      )}
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
    </div>
  );
}
export function PathEditor({ options, onChange }: PanelEditorProps<PathOptions>) {
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
          onChange={(event) =>
            onChange(parsePathOptions({ ...options, caption: event.currentTarget.value }))
          }
        />
      </div>
      <VariableOptions
        id={variableId}
        names={[...new Set([...(host.variables?.names ?? []), ...(host.variables?.multi ?? [])])]}
        options={options}
        onChange={(patch) => onChange(parsePathOptions({ ...options, ...patch }))}
      />
    </>
  );
}
