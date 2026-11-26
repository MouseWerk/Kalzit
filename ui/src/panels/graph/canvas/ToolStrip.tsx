import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../../components/ToolbarMenu";
import { useI18n } from "../../../i18n/i18n";
import { useFloatingMenu } from "../../../shell/useFloatingMenu";
import { useMenuButton } from "../../../shell/useMenuButton";
import type { ShortcutId } from "../../../shortcuts/registry";
import type { CanvasTool } from "../SigmaCanvas";
import { HISTORY_LIMIT, type History } from "./history";
import "./canvas.css";

/** A press on "Undo" held this long opens the history instead of taking a step back, in ms. */
export const LONG_PRESS_MS = 500;
/** Below this canvas width rectangle, lasso, redo and zoom move into "More" (frame 7). */
export const NARROW_CANVAS_PX = 640;

export interface ToolStripProps {
  /** The accessible name's panel title. */
  title: string;
  tool: CanvasTool;
  /** Whether the tool stays after one selection (a double click on it). */
  locked: boolean;
  onTool: (tool: CanvasTool, lock: boolean) => void;
  searching: boolean;
  onSearch: () => void;
  history: History;
  onUndo: () => void;
  onRedo: () => void;
  /** Restores the state after the first `done` steps of the history. */
  onGoTo: (done: number) => void;
  onZoom: (factor: number) => void;
  onFit: () => void;
  /** A narrow panel: rectangle, lasso, redo and zoom move into "More". */
  narrow: boolean;
  /** Before the result is there the tools are shown without function. */
  disabled?: boolean;
}

/**
 * The tools on the canvas, top left (Graph 0.8.1 board, frame 1 and decision 1): the selection
 * tool (pointer, rectangle, lasso), the search, undo and redo with the history, and zoom. What
 * concerns only the canvas lies on it; the panel head keeps layout, style, view, explorer and
 * export. A group of buttons, each its own Tab stop; the pressed tool is a quiet neutral tint.
 */
export function ToolStrip({
  title,
  tool,
  locked,
  onTool,
  searching,
  onSearch,
  history,
  onUndo,
  onRedo,
  onGoTo,
  onZoom,
  onFit,
  narrow,
  disabled = false,
}: ToolStripProps) {
  const { t } = useI18n();
  const canUndo = history.done > 0 && !disabled;
  const canRedo = history.done < history.steps.length && !disabled;
  const toolButton = (
    name: CanvasTool,
    icon: "pointer" | "selectRect" | "lasso",
    key: ShortcutId,
  ) => (
    <IconButton
      key={name}
      icon={icon}
      label={
        tool === name && locked
          ? t("graphCanvas.tool.locked", { tool: t(`graphCanvas.tool.${name}`) })
          : t(`graphCanvas.tool.${name}`)
      }
      shortcut={key}
      tipAlign="start"
      aria-pressed={tool === name}
      data-locked={tool === name && locked ? "" : undefined}
      disabled={disabled}
      onClick={() => onTool(name, false)}
      onDoubleClick={() => onTool(name, name !== "pointer")}
    />
  );
  const more: ToolbarMenuEntry[] = [
    {
      kind: "radio",
      key: "rect",
      label: t("graphCanvas.tool.rect"),
      checked: tool === "rect",
      onSelect: () => onTool("rect", false),
    },
    {
      kind: "radio",
      key: "lasso",
      label: t("graphCanvas.tool.lasso"),
      checked: tool === "lasso",
      onSelect: () => onTool("lasso", false),
    },
    { kind: "separator", key: "s1" },
    {
      key: "redo",
      label: t("graphCanvas.history.redo"),
      icon: "redo",
      disabled: !canRedo,
      onSelect: onRedo,
    },
    { kind: "separator", key: "s2" },
    {
      key: "zoomIn",
      label: t("graph.zoomIn"),
      icon: "zoomIn",
      shortcut: "graph.zoomIn",
      onSelect: () => onZoom(1.5),
    },
    {
      key: "zoomOut",
      label: t("graph.zoomOut"),
      icon: "zoomOut",
      shortcut: "graph.zoomOut",
      onSelect: () => onZoom(1 / 1.5),
    },
    {
      key: "fit",
      label: t("graph.fit"),
      icon: "expand",
      shortcut: "graph.zoomReset",
      onSelect: onFit,
    },
  ];
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of controls, not a field set
    <div className="graph-tools" role="group" aria-label={t("graphCanvas.tools", { title })}>
      {toolButton("pointer", "pointer", "graph.toolPointer")}
      {narrow ? null : toolButton("rect", "selectRect", "graph.toolRect")}
      {narrow ? null : toolButton("lasso", "lasso", "graph.toolLasso")}
      <span className="graph-tools__rule" aria-hidden="true" />
      <IconButton
        icon="search"
        label={t("graphCanvas.search.open")}
        shortcut="graph.search"
        aria-pressed={searching}
        disabled={disabled}
        onClick={onSearch}
      />
      <span className="graph-tools__rule" aria-hidden="true" />
      <HistoryButton
        history={history}
        canUndo={canUndo}
        disabled={disabled}
        onUndo={onUndo}
        onGoTo={onGoTo}
      />
      {narrow ? null : (
        <IconButton
          icon="redo"
          label={t("graphCanvas.history.redo")}
          shortcut="graph.redo"
          disabled={!canRedo}
          onClick={onRedo}
        />
      )}
      {narrow ? (
        disabled ? null : (
          <ToolbarMenu label={t("graphCanvas.tools.more")} icon="more" entries={more} />
        )
      ) : (
        <>
          <span className="graph-tools__rule" aria-hidden="true" />
          <IconButton
            icon="zoomIn"
            label={t("graph.zoomIn")}
            shortcut="graph.zoomIn"
            disabled={disabled}
            onClick={() => onZoom(1.5)}
          />
          <IconButton
            icon="zoomOut"
            label={t("graph.zoomOut")}
            shortcut="graph.zoomOut"
            disabled={disabled}
            onClick={() => onZoom(1 / 1.5)}
          />
          <IconButton
            icon="expand"
            label={t("graph.fit")}
            shortcut="graph.zoomReset"
            disabled={disabled}
            onClick={onFit}
          />
        </>
      )}
    </div>
  );
}

/** "40 s ago", "2 min ago": how long ago a step of the history happened. */
function agoText(language: string, at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: "always", style: "short" });
  if (seconds < 60) return format.format(-seconds, "second");
  if (seconds < 3600) return format.format(-Math.round(seconds / 60), "minute");
  return format.format(-Math.round(seconds / 3600), "hour");
}

/**
 * "Undo" with the history behind it (frame 6): a click takes the newest step back; a long press,
 * Arrow down or the small button beside it opens the list of steps in plain language, newest
 * first. Choosing a step restores the state after it.
 */
function HistoryButton({
  history,
  canUndo,
  disabled,
  onUndo,
  onGoTo,
}: {
  history: History;
  canUndo: boolean;
  disabled: boolean;
  onUndo: () => void;
  onGoTo: (done: number) => void;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const onMenuKeyDown = useFloatingMenu(menu);
  const [host, setHost] = useState<Element | null>(null);
  // When the list was opened: the ages count from then, so the list does not change while read.
  const [openedAt, setOpenedAt] = useState(0);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  const held = useRef(false);
  useEffect(
    () => () => {
      if (press.current !== null) clearTimeout(press.current);
    },
    [],
  );
  function openList(button: HTMLElement) {
    setHost(button.closest("main") ?? document.body);
    setOpenedAt(Date.now());
    menu.toggle();
  }
  const empty = history.steps.length === 0;
  return (
    <div className="menu-anchor graph-tools__history" ref={anchorRef}>
      <IconButton
        icon="undo"
        label={t("graphCanvas.history.undo")}
        shortcut="graph.undo"
        disabled={!canUndo}
        onPointerDown={(event) => {
          held.current = false;
          const button = event.currentTarget;
          press.current = setTimeout(() => {
            held.current = true;
            openList(button);
          }, LONG_PRESS_MS);
        }}
        onPointerUp={() => {
          if (press.current !== null) clearTimeout(press.current);
        }}
        onPointerLeave={() => {
          if (press.current !== null) clearTimeout(press.current);
        }}
        onClick={() => {
          // The click that ends a long press opened the history; it takes nothing back.
          if (!held.current) onUndo();
          held.current = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" && !open) {
            event.preventDefault();
            openList(event.currentTarget);
          }
        }}
      />
      <button
        ref={buttonRef}
        type="button"
        className="button button--ghost icon-button graph-tools__history-open"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={t("graphCanvas.history.open")}
        disabled={disabled || empty}
        onClick={(event) => openList(event.currentTarget)}
        onKeyDown={(event) => {
          setHost(event.currentTarget.closest("main") ?? document.body);
          setOpenedAt(Date.now());
          menu.onButtonKeyDown(event);
        }}
      >
        <Icon name="chevronDown" />
      </button>
      {open
        ? createPortal(
            <div
              ref={menuRef}
              id={menuId}
              role="menu"
              aria-label={t("graphCanvas.history.title")}
              className="menu toolbar-menu__list graph-history"
              onKeyDown={onMenuKeyDown}
            >
              <div className="menu__label" role="presentation">
                {t("graphCanvas.history.count", {
                  count: number.format(history.steps.length),
                  max: number.format(HISTORY_LIMIT),
                })}
              </div>
              {history.steps
                .map((step, index) => ({ step, index }))
                .reverse()
                .map(({ step, index }) => {
                  const current = index === history.done - 1;
                  const undone = index >= history.done;
                  return (
                    <button
                      key={step.id}
                      type="button"
                      role="menuitem"
                      className="menu__item graph-history__step"
                      aria-current={current ? "step" : undefined}
                      data-undone={undone ? "" : undefined}
                      onClick={() => {
                        closeMenu(true);
                        onGoTo(index + 1);
                      }}
                    >
                      <span className="graph-history__label">{step.label}</span>
                      <span className="graph-history__when">
                        {agoText(language, step.at, openedAt)}
                        {current
                          ? ` · ${t("graphCanvas.history.current")}`
                          : undone
                            ? ` · ${t("graphCanvas.history.undone")}`
                            : ""}
                      </span>
                    </button>
                  );
                })}
              <button
                type="button"
                role="menuitem"
                className="menu__item graph-history__step"
                aria-current={history.done === 0 ? "step" : undefined}
                onClick={() => {
                  closeMenu(true);
                  onGoTo(0);
                }}
              >
                <span className="graph-history__label">{t("graphCanvas.history.start")}</span>
              </button>
              <p className="graph-history__note" role="presentation">
                {t("graphCanvas.history.note")}
              </p>
            </div>,
            host ?? document.body,
          )
        : null}
    </div>
  );
}
