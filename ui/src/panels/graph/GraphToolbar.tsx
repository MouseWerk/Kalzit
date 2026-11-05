import { useId } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import type { LayoutMode } from "./layoutProtocol";
import type { ElkDirection } from "./options";
import "./graph.css";

export type GraphDisplay = "graph" | "table";

/** The directions the toolbar offers for a hierarchy (Graph board, frame 3). */
export const TOOLBAR_DIRECTIONS: readonly ElkDirection[] = ["down", "right"];

export interface GraphToolbarProps {
  title: string;
  /** Zoom and "Show all": only while the graph is drawn. */
  drawn: boolean;
  /** The layout and the view choice: only where the browser can draw. */
  drawable: boolean;
  /** The layout choice, or null where the panel does not offer it. */
  layout: { value: LayoutMode; onChange: (mode: LayoutMode) => void } | null;
  /** The hierarchy's direction, or null outside a hierarchy. */
  direction: {
    value: ElkDirection;
    choices: readonly ElkDirection[];
    onChange: (direction: ElkDirection) => void;
  } | null;
  display: GraphDisplay;
  onDisplay: (display: GraphDisplay) => void;
  /** The explorer's switch, or null where the panel has none. */
  explorer: { on: boolean; disabled: boolean; note: string | null; onToggle: () => void } | null;
  /** Closes the opened groups; null while none is open. */
  onCloseGroups: (() => void) | null;
  onZoom: (factor: number) => void;
  onFit: () => void;
}

/**
 * The tools of a graph panel, in the board's order (Graph board, frames 1 and 3): zoom in and out
 * as icons, "Show all", a rule, the layout (network) or the direction (hierarchy), Graph and
 * Table as one segmented choice, and the explorer's switch. Pressed states are a quiet neutral
 * tint, never an accent.
 */
export function GraphToolbar({
  title,
  drawn,
  drawable,
  layout,
  direction,
  display,
  onDisplay,
  explorer,
  onCloseGroups,
  onZoom,
  onFit,
}: GraphToolbarProps) {
  const { t } = useI18n();
  const layoutId = useId();
  const directionId = useId();
  return (
    // A group, not role="toolbar" (which promises one Tab stop with arrow keys inside): each
    // control is its own Tab stop, as in the rest of the panel.
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph__toolbar" role="group" aria-label={t("graph.toolbar", { title })}>
      {drawn ? (
        <>
          <IconButton
            icon="zoomIn"
            label={t("graph.zoomIn")}
            tipAlign="start"
            onClick={() => onZoom(1.5)}
          />
          <IconButton icon="zoomOut" label={t("graph.zoomOut")} onClick={() => onZoom(1 / 1.5)} />
          <button
            type="button"
            className="button button--ghost button--small graph__tool"
            onClick={onFit}
          >
            <Icon name="expand" />
            {t("graph.fit")}
          </button>
          <span className="graph__toolbar-rule" aria-hidden="true" />
        </>
      ) : null}
      {drawable && layout !== null ? (
        <span className="graph__layout">
          <label className="graph__layout-label" htmlFor={layoutId}>
            {t("graph.layout.label")}
          </label>
          <Select
            id={layoutId}
            className="graph__layout-select"
            value={layout.value}
            onChange={(next) => layout.onChange(next as LayoutMode)}
          >
            <option value="force">{t("graph.layout.force")}</option>
            <option value="hierarchy">{t("graph.layout.hierarchy")}</option>
          </Select>
        </span>
      ) : null}
      {drawable && direction !== null ? (
        <span className="graph__layout">
          <label className="visually-hidden" htmlFor={directionId}>
            {t("graph.direction.label")}
          </label>
          <Select
            id={directionId}
            className="graph__layout-select"
            value={direction.value}
            onChange={(next) => direction.onChange(next as ElkDirection)}
          >
            {direction.choices.map((choice) => (
              <option key={choice} value={choice}>
                {t(`graph.options.elkDirection.${choice}`)}
              </option>
            ))}
          </Select>
        </span>
      ) : null}
      {drawable ? (
        // biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a field set
        <div className="graph__segmented" role="group" aria-label={t("graph.view.label")}>
          <button
            type="button"
            className="graph__segment"
            aria-pressed={display === "graph"}
            onClick={() => onDisplay("graph")}
          >
            {t("graph.view.graph")}
          </button>
          <button
            type="button"
            className="graph__segment"
            aria-pressed={display === "table"}
            onClick={() => onDisplay("table")}
          >
            {t("graph.view.table")}
          </button>
        </div>
      ) : null}
      {explorer === null ? null : (
        <button
          type="button"
          className="button button--ghost button--small graph__tool"
          aria-pressed={explorer.on}
          disabled={explorer.disabled}
          title={explorer.note ?? undefined}
          onClick={explorer.onToggle}
        >
          <Icon name="network" />
          {t("graph.explorer.toggle")}
        </button>
      )}
      {onCloseGroups === null ? null : (
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={onCloseGroups}
        >
          {t("graph.cluster.closeAll")}
        </button>
      )}
    </div>
  );
}
