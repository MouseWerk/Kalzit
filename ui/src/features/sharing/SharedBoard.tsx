import { type ReactNode, useId, useRef, useState } from "react";
import type {
  PublicDashboard,
  PublicPanel,
  QueryResponse,
  TimeRange,
} from "../../api/generated/shapes";
import { Icon } from "../../components/Icon";
import { Skeleton } from "../../components/Skeleton";
import { useI18n } from "../../i18n/i18n";
import { useStyleVars } from "../../panels/styleVars";
import { ALL_VALUE, type PanelModel } from "../dashboards/model";
import { PanelBody } from "../dashboards/PanelCard";
import { errorsOf, outcomesOf } from "../dashboards/results";
import { fixedVariables } from "./model";
import "../dashboards/dashboards.css";
import "../dashboards/dashboardTools.css";
import "./sharing.css";

/*
 * A shared dashboard as visitors and snapshot readers see it: the panels on their grid, without
 * menus, queries or sources. The answers come from the server ready to draw (its steps ran
 * there), so a panel here has no steps of its own.
 */

/** The panel as the drawing code takes it; the queries are known by their reference id only. */
export function panelModel(panel: PublicPanel): PanelModel {
  return {
    id: panel.id,
    type: panel.type,
    title: panel.title,
    grid: panel.grid,
    targets: panel.targets
      .filter((target) => !target.hide)
      .map((target) => ({ refId: target.refId, datasourceId: "", query: null })),
    transformations: [],
    options: panel.options,
    fieldConfig: panel.fieldConfig,
    ...(panel.description === undefined ? {} : { description: panel.description }),
    ...(panel.transparent ? { transparent: true } : {}),
  };
}

/** Draws what is inside one card: the panel as shared, and as the drawing code takes it. */
export type BoardBody = (panel: PublicPanel, model: PanelModel) => ReactNode;

interface Section {
  row: PublicDashboard["rows"][number] | null;
  panels: PublicPanel[];
}

function sectionsOf(dashboard: PublicDashboard): Section[] {
  const known = new Set(dashboard.rows.map((row) => row.id));
  const top = dashboard.panels.filter(
    (panel) => panel.rowId === undefined || !known.has(panel.rowId),
  );
  return [
    { row: null, panels: top },
    ...dashboard.rows.map((row) => ({
      row,
      panels: dashboard.panels.filter((panel) => panel.rowId === row.id),
    })),
  ];
}

/** The panels of a shared dashboard on its grid; `body` draws what is inside each card. */
export function SharedBoard({ dashboard, body }: { dashboard: PublicDashboard; body: BoardBody }) {
  const { t } = useI18n();
  const sections = sectionsOf(dashboard);
  // Rows open as the dashboard stores them; a reader may fold and unfold them.
  const [open, setOpen] = useState<Record<string, boolean>>({});
  if (dashboard.panels.length === 0) {
    return <p className="share-board__empty">{t("sharing.viewer.noPanels")}</p>;
  }
  return (
    <div className="share-board">
      {sections.map((section) => {
        const row = section.row;
        const shown = row === null || (open[row.id] ?? !row.collapsed);
        return (
          <section key={row?.id ?? "top"} className="share-board__section">
            {row === null ? null : (
              <div className="dash-row">
                <button
                  type="button"
                  className="dash-row__toggle"
                  aria-expanded={shown}
                  onClick={() => setOpen((current) => ({ ...current, [row.id]: !shown }))}
                >
                  <Icon name={shown ? "chevronDown" : "chevron"} className="dash-row__chevron" />
                  <span className="dash-row__title truncate" title={row.title}>
                    {row.title}
                  </span>
                  <span className="dash-row__count">{section.panels.length}</span>
                </button>
              </div>
            )}
            {shown && section.panels.length > 0 ? (
              <BoardGrid panels={section.panels} body={body} />
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

function BoardGrid({ panels, body }: { panels: readonly PublicPanel[]; body: BoardBody }) {
  // A section's panels count their rows from its own top.
  const top = Math.min(...panels.map((panel) => panel.grid.y));
  return (
    <div className="dash-grid">
      {panels.map((panel) => (
        <BoardCard key={panel.id} panel={panel} top={top} body={body} />
      ))}
    </div>
  );
}

function BoardCard({ panel, top, body }: { panel: PublicPanel; top: number; body: BoardBody }) {
  const titleId = useId();
  const ref = useRef<HTMLElement>(null);
  useStyleVars(ref, {
    "--col": panel.grid.x + 1,
    "--row": panel.grid.y - top + 1,
    "--w": panel.grid.w,
    "--h": panel.grid.h,
  });
  return (
    <article
      ref={ref}
      className={panel.transparent ? "panel-card panel-card--transparent" : "panel-card"}
      aria-labelledby={titleId}
      data-panel-id={panel.id}
    >
      <header className="panel-card__header">
        <h2 className="panel-card__title truncate" id={titleId} title={panel.title}>
          {panel.title}
        </h2>
      </header>
      <div className="panel-card__body">{body(panel, panelModel(panel))}</div>
    </article>
  );
}

/**
 * What a shared panel shows for an answer. A failed query never shows the source's words: one
 * neutral line instead (the creator finds the reason under "Meine Freigaben").
 */
export function SharedPanelBody({
  model,
  range,
  response,
  pending,
  failed,
  busy = false,
  variables,
  missing,
  unavailable,
}: {
  model: PanelModel;
  range: TimeRange;
  response: QueryResponse | undefined;
  pending: boolean;
  failed: boolean;
  /** It failed because the server was busy: worth saying, since a moment later it works. */
  busy?: boolean;
  variables: Readonly<Record<string, string>>;
  /** The text when the panel has no answer at all (left out of a snapshot). */
  missing?: string;
  /**
   * The text for a failed answer. A live link says it cannot be loaded right now; a snapshot's
   * answer is frozen, so it says there was none when it was made.
   */
  unavailable?: string;
}) {
  const { t } = useI18n();
  const outcomes =
    response === undefined
      ? []
      : outcomesOf(
          response,
          model.targets.map((target) => target.refId),
        );
  const standalone = model.targets.length === 0;
  if (!standalone && !pending && response === undefined && missing !== undefined) {
    return <p className="panel-empty share-panel__quiet">{missing}</p>;
  }
  if (failed || errorsOf(outcomes).length > 0) {
    return (
      <p className="panel-empty share-panel__quiet" role="status">
        {busy ? t("sharing.reason.busy") : (unavailable ?? t("sharing.viewer.panelUnavailable"))}
      </p>
    );
  }
  // Its queries are known by name only, so the drawing code cannot tell "loading" itself.
  if (pending && !standalone) {
    return <Skeleton variant="panel" className="panel-skeleton" />;
  }
  return (
    <PanelBody
      panel={model}
      title={model.title}
      range={range}
      pending={pending}
      error={null}
      outcomes={outcomes}
      variables={variables}
      reader
    />
  );
}

/** The fixed variable values of a shared dashboard: readable, not changeable. */
export function FixedValues({ dashboard }: { dashboard: PublicDashboard }) {
  const { t } = useI18n();
  const variables = fixedVariables(dashboard.variables).filter((variable) => variable.value !== "");
  if (variables.length === 0) {
    return null;
  }
  return (
    <ul className="share-fixed" aria-label={t("sharing.viewer.fixedValues")}>
      {variables.map((variable) => (
        <li key={variable.name} className="share-fixed__item">
          <span className="share-fixed__name">{variable.label}</span>
          <span className="share-fixed__value">
            {/* "All": the link reads the values each time it runs. */}
            {variable.value === ALL_VALUE ? t("sharing.viewer.all") : variable.value}
          </span>
          <Icon name="lock" className="share-fixed__lock" />
          <span className="visually-hidden">{t("sharing.viewer.fixed")}</span>
        </li>
      ))}
    </ul>
  );
}

/** The fixed values by name, for panels that put variables into text. */
export function variableTextsOf(dashboard: PublicDashboard): Record<string, string> {
  return Object.fromEntries(
    fixedVariables(dashboard.variables).map((variable) => [variable.name, variable.value]),
  );
}
