import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { type DependencyReport, dependencies, type VariableUse } from "./dependencies";
import type { DashboardModel } from "./model";
import "./dashboards.css";

/** Node size and spacing of the drawing, in its own units (it scales to the width it has). */
const NODE_W = 140;
const NODE_H = 40;
const COLUMN = 190;
const ROW = 60;
const PAD = 16;
/** Places listed by name before the rest are counted. */
const LISTED = 3;

/**
 * "Abhängigkeiten" (board ParityEditors, frame 11): which variable needs which, where each is
 * used, and what is unused, unknown or in a cycle. The drawing shows the load order from left to
 * right and ends in the panels; the table under it says the same for keyboard and screen reader.
 */
export function VariableDependencies({
  model,
  onRemove,
  onCreate,
}: {
  /** The dashboard with the variables as edited on the page. */
  model: DashboardModel;
  /** Removes an unused variable; left out for people who may not edit. */
  onRemove?: ((name: string) => void) | undefined;
  /** Adds a variable of this name (one that is used but missing); left out likewise. */
  onCreate?: ((name: string) => void) | undefined;
}) {
  const { t } = useI18n();
  const report = dependencies(model);
  if (model.variables.length === 0 && report.unknown.length === 0) {
    return <p className="field__hint">{t("dashboards.dependencies.empty")}</p>;
  }
  const placesOf = (uses: readonly VariableUse[]) => usesText(t, uses);
  return (
    <div className="dependencies">
      <DependencyGraph report={report} />
      {report.cycles.map((cycle) => (
        <p key={cycle.join(" ")} className="notice notice--danger" role="alert">
          <Icon name="alert" />
          <span>
            {t("dashboards.dependencies.cycle", {
              names: [...cycle, cycle[0]].map((n) => `$${n}`).join(" → "),
            })}
          </span>
        </p>
      ))}
      {report.unknown.map((entry) => (
        <div key={entry.name} className="notice dependencies__unknown">
          <Icon name="info" />
          <span>
            {t("dashboards.dependencies.unknown", {
              places: placesOf(entry.usedBy),
              name: `$${entry.name}`,
            })}
          </span>
          {onCreate === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) ? null : (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => onCreate(entry.name)}
            >
              {t("dashboards.dependencies.create", { name: entry.name })}
            </button>
          )}
        </div>
      ))}
      <div className="dependencies__wrap">
        <table className="dependencies__table">
          <caption className="visually-hidden">{t("dashboards.dependencies.caption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("dashboards.dependencies.variable")}</th>
              <th scope="col">{t("dashboards.dependencies.dependsOn")}</th>
              <th scope="col">{t("dashboards.dependencies.usedIn")}</th>
            </tr>
          </thead>
          <tbody>
            {report.variables.map(({ variable, dependsOn, usedBy }) => (
              <tr key={variable.name}>
                <th scope="row" className="dependencies__name">
                  ${variable.name}
                </th>
                <td className="dependencies__names">
                  {dependsOn.length === 0 ? "–" : dependsOn.map((n) => `$${n}`).join(", ")}
                </td>
                <td>
                  {usedBy.length > 0 ? (
                    placesOf(usedBy)
                  ) : (
                    <span className="dependencies__unused">
                      <span className="dependencies__muted">
                        {t("dashboards.dependencies.nowhere")}
                      </span>
                      {onRemove === undefined ? null : (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onRemove(variable.name)}
                        >
                          {t("dashboards.variables.remove", { name: variable.name })}
                        </button>
                      )}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

type Translate = ReturnType<typeof useI18n>["t"];

/** "CPU je Host, Speicher je Host und 4 weitere": places by name, the rest counted. */
export function usesText(t: Translate, uses: readonly VariableUse[]): string {
  const named = uses.map((use) => {
    switch (use.kind) {
      case "panel":
        return use.name === "" ? t("dashboards.dependencies.untitledPanel") : use.name;
      case "variable":
        return `$${use.name}`;
      case "row":
        return t("dashboards.dependencies.row", { name: use.name });
      case "annotation":
        return t("dashboards.dependencies.annotation", { name: use.name });
      default:
        return t("dashboards.dependencies.link", { name: use.name });
    }
  });
  if (named.length <= LISTED) return named.join(", ");
  return t("dashboards.dependencies.andMore", {
    names: named.slice(0, LISTED).join(", "),
    count: named.length - LISTED,
  });
}

/**
 * The drawing: each variable in the column of its load order, arrows to the variables that need
 * it, and one node for the panels that use variables at the end. Quiet node shapes, no colors.
 */
function DependencyGraph({ report }: { report: DependencyReport }) {
  const { t } = useI18n();
  const columns: string[][] = [];
  for (const { variable } of report.variables) {
    const level = report.levels[variable.name] ?? 0;
    const column = columns[level] ?? [];
    column.push(variable.name);
    columns[level] = column;
  }
  const at = new Map<string, { x: number; y: number }>();
  columns.forEach((names, column) => {
    names.forEach((name, row) => {
      at.set(name, { x: PAD + column * COLUMN, y: PAD + row * ROW });
    });
  });
  const fedPanels = report.variables.filter((d) => d.usedBy.some((u) => u.kind === "panel"));
  const tallest = Math.max(1, ...columns.map((c) => c.length));
  const panelsX = PAD + columns.length * COLUMN;
  const panelsY = PAD + ((tallest - 1) * ROW) / 2;
  const width = (report.panelsUsing > 0 ? panelsX + NODE_W : panelsX - COLUMN + NODE_W) + PAD;
  const height = PAD * 2 + (tallest - 1) * ROW + NODE_H;
  const edge = (from: { x: number; y: number }, to: { x: number; y: number }, key: string) => {
    const x1 = from.x + NODE_W;
    const y1 = from.y + NODE_H / 2;
    const x2 = to.x - 6;
    const y2 = to.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    return (
      <g key={key}>
        <path
          className="dependencies__edge"
          d={`M${x1} ${y1} C${mid} ${y1},${mid} ${y2},${x2} ${y2}`}
        />
        <path
          className="dependencies__edge"
          d={`M${x2 - 6} ${y2 - 3.5}L${x2} ${y2}L${x2 - 6} ${y2 + 3.5}`}
        />
      </g>
    );
  };
  const type = (name: string) => report.variables.find((d) => d.variable.name === name);
  return (
    <svg
      className="dependencies__graph"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      role="img"
      aria-label={t("dashboards.dependencies.graph")}
    >
      {report.variables.flatMap(({ variable, dependsOn }) => {
        const to = at.get(variable.name);
        return dependsOn.flatMap((name) => {
          const from = at.get(name);
          return from === undefined || to === undefined
            ? []
            : [edge(from, to, `${name}->${variable.name}`)];
        });
      })}
      {report.panelsUsing > 0
        ? fedPanels.flatMap(({ variable }) => {
            const from = at.get(variable.name);
            return from === undefined
              ? []
              : [edge(from, { x: panelsX, y: panelsY }, `${variable.name}->panels`)];
          })
        : null}
      {[...at.entries()].map(([name, { x, y }]) => {
        const entry = type(name);
        const unused = entry !== undefined && entry.usedBy.length === 0;
        return (
          <g key={name}>
            <rect
              className="dependencies__node"
              x={x}
              y={y}
              width={NODE_W}
              height={NODE_H}
              rx={8}
            />
            <text className="dependencies__label" x={x + 12} y={y + 17}>
              {clip(`$${name}`, 16)}
            </text>
            <text className="dependencies__sub" x={x + 12} y={y + 31}>
              {unused
                ? t("dashboards.dependencies.unusedNode")
                : entry === undefined
                  ? ""
                  : t(`dashboards.variables.type.${entry.variable.type}`)}
            </text>
          </g>
        );
      })}
      {report.panelsUsing > 0 ? (
        <g>
          <rect
            className="dependencies__node"
            x={panelsX}
            y={panelsY}
            width={NODE_W}
            height={NODE_H}
            rx={8}
          />
          <text className="dependencies__label" x={panelsX + 12} y={panelsY + 24}>
            {t("dashboards.dependencies.panels", { count: report.panelsUsing })}
          </text>
        </g>
      ) : null}
    </svg>
  );
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
