import { useI18n } from "../../i18n/i18n";
import { propertyText } from "./adapter";
import { edgeSummary, neighbourGroups, propertyType } from "./inspect";
import type { Communities } from "./metrics";
import type { GraphModel } from "./model";
import type { GraphView } from "./view";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/** Neighbours listed per group before "and N more". */
export const NEIGHBOURS_SHOWN = 5;

/** A pinned node in the list: its id, caption, and the step that brought it (0: the query). */
export interface PinEntry {
  id: string;
  caption: string;
  step: number;
  /** Its view index, when it is drawn. */
  index: number | null;
}

export interface SheetActions {
  /** Selects one node (a neighbour, a pin, an entry of the selection). */
  select: (index: number) => void;
  /** Takes a node out of the selection. */
  deselect: (index: number) => void;
  clear: () => void;
  togglePin: (id: string) => void;
  open: (index: number) => void;
  /** Loads neighbours of the node, or the next ones; null where the explorer cannot. */
  expand: ((index: number) => void) | null;
  /** Sets the single-value variable from the node; null without one. */
  setVariable: ((index: number) => void) | null;
  /** Sets the multi-value variable from the selection; null without one or without values. */
  setValues: (() => void) | null;
  toggleOnly: () => void;
}

/**
 * The side sheet of a graph panel (Graph board, frames 1 and 2): for one selected node its labels,
 * typed properties, degree and neighbours grouped by edge type, with "Load neighbours" and
 * "Set $variable"; for several the selection with "Show only the selection" and the multi-value
 * variable; and the pinned nodes. Selection is quiet here too: neutral tint and weight.
 */
export function NodeSheet({
  model,
  view,
  parts,
  found,
  selected,
  primary,
  pinned,
  pins,
  only,
  variable,
  values,
  capped,
  expandText,
  moreText,
  actions,
}: {
  model: GraphModel;
  view: GraphView;
  parts: { of: Int32Array; sizes: number[] };
  found: Communities | null;
  /** Selected view indexes, in the order they were selected. */
  selected: readonly number[];
  /** The node the details are of. */
  primary: number | null;
  /** Node ids pinned. */
  pinned: ReadonlySet<string>;
  pins: readonly PinEntry[];
  only: boolean;
  variable: string | null;
  /** The multi-value variable's values from the selection. */
  values: readonly string[];
  /** Some selected nodes' values were left out: a variable takes only so many. */
  capped: boolean;
  /** The text of the expand button for the primary node, or null to leave it out. */
  expandText: string | null;
  /** "Ada has 312 neighbours, 25 are loaded." for the primary node, or null. */
  moreText: string | null;
  actions: SheetActions;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const node = primary === null ? undefined : view.nodes[primary];
  const data = node !== undefined && node.node >= 0 ? model.nodes[node.node] : undefined;

  return (
    <section
      className="graph__details"
      aria-label={
        node === undefined ? t("graph.sheet.label") : t("graph.details", { name: node.caption })
      }
    >
      {node === undefined ? null : (
        <section className="graph-sheet__section">
          <h3 className="graph__details-title">{node.caption}</h3>
          {data === undefined ? (
            <>
              <p className="graph__note">
                {t("graph.cluster.members", { count: number.format(node.members) })}
              </p>
              <div className="graph__actions">
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => actions.open(primary as number)}
                >
                  {t("graph.cluster.open")}
                </button>
              </div>
            </>
          ) : (
            <>
              {data.labels.length === 0 ? null : (
                <ul className="graph-sheet__labels" aria-label={t("graph.table.labels")}>
                  {data.labels.map((label) => (
                    <li key={label} className="graph-sheet__chip">
                      {label}
                    </li>
                  ))}
                </ul>
              )}
              <p className="graph-sheet__id">
                <span className="graph-sheet__key">{t("graph.sheet.id")}</span>{" "}
                <code>{data.id}</code>
              </p>
              <h4 className="graph-sheet__heading">{t("graph.sheet.properties")}</h4>
              {Object.keys(data.properties).length === 0 ? (
                <p className="graph__note">{t("graph.sheet.noProperties")}</p>
              ) : (
                <dl className="graph-sheet__properties">
                  {Object.entries(data.properties).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd>{propertyText(value)}</dd>
                      <dd className="graph-sheet__type">
                        {t(`graph.type.${propertyType(value)}`)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              <h4 className="graph-sheet__heading">{t("graph.sheet.metrics")}</h4>
              <dl className="graph__properties">
                <div>
                  <dt>{t("graph.metric.degree")}</dt>
                  <dd>
                    {t("graph.metric.degreeValue", {
                      count: number.format(data.degree),
                      in: number.format(data.inDegree),
                      out: number.format(data.outDegree),
                    })}
                  </dd>
                </div>
                <div>
                  <dt>{t("graph.metric.component")}</dt>
                  <dd>
                    {t("graph.metric.componentValue", {
                      number: number.format((parts.of[node.node] ?? 0) + 1),
                      count: number.format(parts.sizes[parts.of[node.node] ?? 0] ?? 0),
                    })}
                  </dd>
                </div>
                {found === null ? null : (
                  <div>
                    <dt>{t("graph.metric.community")}</dt>
                    <dd>{number.format((found.of[node.node] ?? 0) + 1)}</dd>
                  </div>
                )}
              </dl>
              <Neighbours model={model} view={view} node={node.node} actions={actions} />
              {moreText === null ? null : <p className="graph__note">{moreText}</p>}
              <div className="graph__actions">
                {expandText === null || actions.expand === null ? null : (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => actions.expand?.(primary as number)}
                  >
                    {expandText}
                  </button>
                )}
                {variable === null || actions.setVariable === null ? null : (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => actions.setVariable?.(primary as number)}
                  >
                    {t("graph.variable.set", { name: variable })}
                  </button>
                )}
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-pressed={pinned.has(data.id)}
                  aria-keyshortcuts="P"
                  onClick={() => actions.togglePin(data.id)}
                >
                  {pinned.has(data.id) ? t("graph.pin.remove") : t("graph.pin.add")}
                </button>
              </div>
            </>
          )}
        </section>
      )}
      {selected.length === 0 ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a part of the sheet, not form fields; a group, not a landmark, so panels never repeat a region name
        <div className="graph-sheet__section" role="group" aria-label={t("graph.selection.title")}>
          <h4 className="graph-sheet__heading">
            {t("graph.selection.count", { count: number.format(selected.length) })}
          </h4>
          {selected.length > 1 ? (
            <ul className="graph-sheet__list">
              {selected.map((index) => {
                const entry = view.nodes[index];
                if (entry === undefined) return null;
                const id = entry.node >= 0 ? model.nodes[entry.node]?.id : undefined;
                return (
                  <li key={entry.key} className="graph-sheet__item">
                    <button
                      type="button"
                      className="graph-sheet__link"
                      aria-current={index === primary ? "true" : undefined}
                      onClick={() => actions.select(index)}
                    >
                      {entry.caption}
                    </button>
                    {id !== undefined && pinned.has(id) ? (
                      <span className="graph-sheet__muted">{t("graph.pin.pinned")}</span>
                    ) : null}
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      aria-label={t("graph.selection.removeNamed", { name: entry.caption })}
                      onClick={() => actions.deselect(index)}
                    >
                      {t("graph.selection.remove")}
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          <p className="graph__note">{t("graph.selection.hint")}</p>
          {capped && variable !== null ? (
            <p className="graph__note">
              {t("graph.variable.capped", { name: variable, count: number.format(values.length) })}
            </p>
          ) : null}
          <div className="graph__actions">
            <button
              type="button"
              className="button button--ghost button--small"
              aria-pressed={only}
              aria-keyshortcuts="S"
              onClick={actions.toggleOnly}
            >
              {t("graph.selection.only")}
            </button>
            {variable === null || actions.setValues === null ? null : (
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={actions.setValues}
              >
                {t("graph.variable.setMany", {
                  name: variable,
                  count: number.format(values.length),
                })}
              </button>
            )}
            {selected.length > 1 ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={actions.clear}
              >
                {t("graph.selection.clear")}
              </button>
            ) : null}
          </div>
        </div>
      )}
      {pins.length === 0 ? null : (
        // biome-ignore lint/a11y/useSemanticElements: a part of the sheet, not form fields; a group, not a landmark, so panels never repeat a region name
        <div className="graph-sheet__section" role="group" aria-label={t("graph.pin.title")}>
          <h4 className="graph-sheet__heading">
            {t("graph.pin.count", { count: number.format(pins.length) })}
          </h4>
          <ul className="graph-sheet__list">
            {pins.map((pin) => (
              <li key={pin.id} className="graph-sheet__item">
                {pin.index === null ? (
                  <span>{pin.caption}</span>
                ) : (
                  <button
                    type="button"
                    className="graph-sheet__link"
                    onClick={() => actions.select(pin.index as number)}
                  >
                    {pin.caption}
                  </button>
                )}
                <span className="graph-sheet__muted">
                  {pin.step === 0
                    ? t("graph.pin.fromQuery")
                    : t("graph.pin.fromStep", { number: number.format(pin.step) })}
                </span>
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("graph.pin.removeNamed", { name: pin.caption })}
                  onClick={() => actions.togglePin(pin.id)}
                >
                  {t("graph.pin.remove")}
                </button>
              </li>
            ))}
          </ul>
          <p className="graph__note">{t("graph.pin.hint")}</p>
        </div>
      )}
    </section>
  );
}

/** The node's neighbours, grouped by edge type, direction and label. */
function Neighbours({
  model,
  view,
  node,
  actions,
}: {
  model: GraphModel;
  view: GraphView;
  node: number;
  actions: SheetActions;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const groups = neighbourGroups(model, node);
  const total = groups.reduce((sum, g) => sum + g.items.length, 0);
  if (total === 0) return null;
  return (
    <>
      <h4 className="graph-sheet__heading">
        {t("graph.sheet.neighbours", { count: number.format(total) })}
      </h4>
      <ul className="graph-sheet__groups">
        {groups.map((group) => (
          <li key={group.key}>
            <p className="graph-sheet__group">
              <span className="graph-sheet__type-name">{group.type}</span>{" "}
              <span aria-hidden="true">{group.outgoing ? "→" : "←"}</span>
              <span className="visually-hidden">
                {group.outgoing ? t("graph.path.forward") : t("graph.path.backward")}
              </span>{" "}
              {group.label === "" ? t("graph.cluster.unlabelled") : group.label}
              {" · "}
              {number.format(group.items.length)}
            </p>
            <ul className="graph-sheet__list">
              {group.items.slice(0, NEIGHBOURS_SHOWN).map((item) => {
                const other = model.nodes[item.node];
                const at = view.nodeOf[item.node] ?? -1;
                const summary = edgeSummary(model.edges[item.edge]?.properties ?? {});
                if (other === undefined) return null;
                return (
                  <li key={`${item.edge}`} className="graph-sheet__item">
                    {at >= 0 && (view.nodes[at]?.node ?? -1) >= 0 ? (
                      <button
                        type="button"
                        className="graph-sheet__link"
                        onClick={() => actions.select(at)}
                      >
                        {other.caption}
                      </button>
                    ) : (
                      <span>{other.caption}</span>
                    )}
                    {summary === "" ? null : <span className="graph-sheet__muted">{summary}</span>}
                  </li>
                );
              })}
            </ul>
            {group.items.length > NEIGHBOURS_SHOWN ? (
              <p className="graph__note">
                {t("graph.sheet.moreNeighbours", {
                  count: number.format(group.items.length - NEIGHBOURS_SHOWN),
                })}
              </p>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}
