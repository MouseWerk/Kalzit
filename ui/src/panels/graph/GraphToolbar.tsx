import { useId } from "react";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { LayoutMenu, type LayoutMenuProps } from "./layouts/LayoutMenu";
import type { ElkDirection } from "./options";
import "./graph.css";

export type GraphDisplay = "graph" | "table";

/** The directions the toolbar offers for a hierarchy (Graph board, frame 3). */
export const TOOLBAR_DIRECTIONS: readonly ElkDirection[] = ["down", "right"];

export interface GraphToolbarProps {
  title: string;
  /** The layout and the view choice: only where the browser can draw. */
  drawable: boolean;
  /** The layout menu, or null where the panel does not offer it. */
  layout: LayoutMenuProps | null;
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
  /** The button "Stil" of the style rules (style/StyleSheet.tsx); absent where there is none. */
  styleRules?: { count: number; open: boolean; toggle: () => void } | undefined;
}

/**
 * The head of a graph panel (Graph board, frames 1 and 3; Graph 0.8.1 board, decision 1): the
 * layout as a button with a menu (network; Graph081 board, frame 12) or the direction
 * (hierarchy), Graph and Table as one segmented choice, and the explorer's switch. Zoom and
 * "Show all" lie on the canvas with the other canvas tools (canvas/ToolStrip.tsx). Pressed states
 * are a quiet neutral tint, never an accent.
 */
export function GraphToolbar({
  title,
  drawable,
  layout,
  direction,
  display,
  onDisplay,
  explorer,
  onCloseGroups,
  styleRules,
}: GraphToolbarProps) {
  const { t } = useI18n();
  const directionId = useId();
  return (
    // A group, not role="toolbar" (which promises one Tab stop with arrow keys inside): each
    // control is its own Tab stop, as in the rest of the panel.
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph__toolbar" role="group" aria-label={t("graph.toolbar", { title })}>
      {drawable && layout !== null ? <LayoutMenu {...layout} /> : null}
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
      {styleRules === undefined ? null : (
        <button
          type="button"
          className="button button--ghost button--small graph__tool"
          aria-pressed={styleRules.open}
          aria-label={t("graphStyle.button.label", { count: styleRules.count })}
          onClick={styleRules.toggle}
        >
          <Icon name="palette" />
          {t("graphStyle.button")}
        </button>
      )}
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
