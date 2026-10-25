import { type ReactNode, useRef } from "react";
import { Icon } from "../../components/Icon";
import { WithTooltip } from "../../components/IconButton";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { useWideLayout } from "../../shell/sidebarState";
import { useHeightVar } from "../../shell/useHeightVar";
import { RefreshControl } from "./RefreshControl";
import { TimeControls } from "./TimeRangePicker";
import type { TextRange } from "./timeRange";
import "./toolbar.css";

/** What the toolbar and the rail can start; the page decides what each does. */
export interface ToolbarActions {
  edit: () => void;
  /** Leaves edit mode: asks first when something changed. */
  leaveEdit: () => void;
  save: () => void;
  addPanel: () => void;
  addRow: () => void;
  addLibraryPanel: () => void;
  settings: () => void;
  json: () => void;
  exportJson: () => void;
  copyLink: () => void;
  saveAs: () => void;
  history: () => void;
  access: () => void;
  remove: () => void;
  kiosk: () => void;
  tv: () => void;
  exitMode: () => void;
}

interface DashboardToolbarProps {
  /** The dashboard's name: the page's heading, read by screen readers (the trail shows it). */
  title: string;
  headingId: string;
  mode: "normal" | "tv";
  /** Edit mode, and whether the draft differs from the saved dashboard. */
  editing: boolean;
  dirty: boolean;
  can: { edit: boolean; remove: boolean; access: boolean; saveAs: boolean };
  /** The playlist's controls, before the time range. */
  controls?: ReactNode;
  /** The filter bar (variables and links), at the start of the row. */
  filters?: ReactNode;
  /** Why the range does not resolve, shown before the picker. */
  rangeError?: string | undefined;
  range: TextRange;
  onRange: (range: TextRange) => void;
  userId: string;
  dashboardZone: boolean;
  /** The dashboard's now delay, for the time picker's preview. */
  nowDelay: string | undefined;
  /** The time shortcuts listen while the toolbar is the page's. */
  shortcuts: boolean;
  refreshSeconds: number;
  onRefreshSeconds: (seconds: number) => void;
  refreshIntervals: readonly number[] | undefined;
  onRefresh: () => void;
  actions: ToolbarActions;
}

/**
 * The dashboard's toolbar row, under the top bar that names the dashboard in its trail: the star
 * on the left; on the right the time range with its neighbors, refresh and share as split
 * buttons, one overflow menu and Edit (Save is the one copper button, in edit mode). Adding
 * panels, settings, export and the outline are on the rail at the canvas' right edge. On a phone
 * the rail's actions and Edit move into the overflow menu.
 */
export function DashboardToolbar({
  title,
  headingId,
  mode,
  editing,
  dirty,
  can,
  controls,
  filters,
  rangeError,
  range,
  onRange,
  userId,
  dashboardZone,
  nowDelay,
  shortcuts,
  refreshSeconds,
  onRefreshSeconds,
  refreshIntervals,
  onRefresh,
  actions,
}: DashboardToolbarProps) {
  const { t } = useI18n();
  // The toolbar sticks under the top bar; the rail sticks under both.
  const toolbarRef = useRef<HTMLDivElement>(null);
  useHeightVar(toolbarRef, "--dash-toolbar-height", "(min-width: 48rem)");
  const wide = useWideLayout();
  const tv = mode === "tv";

  const shareEntries: ToolbarMenuEntry[] = [
    { key: "link", label: t("toolbar.share.copyLink"), icon: "copy", onSelect: actions.copyLink },
    {
      key: "export",
      label: t("dashboardTools.export"),
      icon: "download",
      onSelect: actions.exportJson,
    },
    {
      key: "json",
      label: editing ? t("dashboardTools.json.open") : t("dashboardTools.json.view"),
      icon: "code",
      onSelect: actions.json,
    },
  ];

  const more: ToolbarMenuEntry[] = [];
  if (!wide) {
    // The rail's actions and Edit, which a phone has no room for.
    if (editing) {
      more.push(
        {
          key: "leave",
          label: dirty ? t("dashboards.discard") : t("dashboards.doneEditing"),
          onSelect: actions.leaveEdit,
        },
        { key: "leave-sep", kind: "separator" },
        { key: "add-heading", kind: "heading", label: t("toolbar.add") },
        { key: "panel", label: t("dashboards.addPanel"), icon: "plus", onSelect: actions.addPanel },
        { key: "row", label: t("dashboardTools.rows.add"), onSelect: actions.addRow },
        { key: "library", label: t("libraryPanels.add"), onSelect: actions.addLibraryPanel },
        { key: "add-sep", kind: "separator" },
      );
    } else if (can.edit) {
      more.push({ key: "edit", label: t("dashboards.edit"), icon: "edit", onSelect: actions.edit });
    }
  }
  if (can.edit) {
    more.push({
      key: "settings",
      label: t("dashboards.settings"),
      icon: "settings",
      onSelect: actions.settings,
    });
  }
  more.push(
    {
      key: "kiosk",
      label: t("dashboardTools.view.kiosk"),
      icon: "expand",
      onSelect: actions.kiosk,
    },
    { key: "tv", label: t("dashboardTools.view.tv"), icon: "screen", onSelect: actions.tv },
    { key: "history", label: t("dashboards.versions"), icon: "history", onSelect: actions.history },
  );
  if (can.access) {
    more.push({
      key: "access",
      label: t("dashboards.access"),
      icon: "members",
      onSelect: actions.access,
    });
  }
  if (can.saveAs) {
    more.push({
      key: "saveAs",
      label: t("dashboardTools.saveAs.button"),
      icon: "copy",
      onSelect: actions.saveAs,
    });
  }
  if (can.remove) {
    more.push(
      { key: "remove-sep", kind: "separator" },
      {
        key: "remove",
        label: t("dashboards.delete"),
        icon: "trash",
        danger: true,
        onSelect: actions.remove,
      },
    );
  }

  return (
    <div ref={toolbarRef} className={tv ? "dash-toolbar dash-toolbar--tv" : "dash-toolbar"}>
      <h1 className="visually-hidden" id={headingId}>
        {title}
      </h1>
      <div className="dash-toolbar__start">
        {filters}
        {controls}
      </div>
      <div className="dash-toolbar__tools">
        {rangeError === undefined ? null : <span className="field__error">{rangeError}</span>}
        <TimeControls
          value={range}
          onChange={onRange}
          userId={userId}
          dashboardZone={dashboardZone}
          nowDelay={nowDelay}
          shortcuts={shortcuts}
        />
        <RefreshControl
          onRefresh={onRefresh}
          seconds={refreshSeconds}
          onSeconds={onRefreshSeconds}
          intervals={refreshIntervals}
        />
        {tv ? (
          <button type="button" className="button button--secondary" onClick={actions.exitMode}>
            {t("dashboardTools.view.exit")}
          </button>
        ) : (
          <>
            {/* biome-ignore lint/a11y/useSemanticElements: a pair of buttons, not a set of form fields */}
            <div className="split-control" role="group" aria-label={t("toolbar.share")}>
              <WithTooltip label={t("toolbar.share.copyLink")}>
                <button
                  type="button"
                  className="button button--ghost icon-button split-control__main"
                  aria-label={t("toolbar.shareButton")}
                  onClick={actions.copyLink}
                >
                  <Icon name="share" />
                  <span className="dash-toolbar__text">{t("toolbar.shareButton")}</span>
                </button>
              </WithTooltip>
              <ToolbarMenu
                label={t("toolbar.shareOptions")}
                icon="chevronDown"
                className="split-control__menu"
                entries={shareEntries}
              />
            </div>
            {editing ? (
              <>
                {wide ? (
                  // "Done" takes the place of "Edit", so a second click on that spot never adds.
                  <button
                    type="button"
                    className="button button--secondary"
                    onClick={actions.leaveEdit}
                  >
                    {dirty ? t("dashboards.discard") : t("dashboards.doneEditing")}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="button button--primary"
                  onClick={actions.save}
                  disabled={!dirty}
                >
                  {t("dashboards.save")}
                </button>
              </>
            ) : can.edit && wide ? (
              // Secondary: copper is for Save, the one main action while editing.
              <button type="button" className="button button--secondary" onClick={actions.edit}>
                <Icon name="edit" />
                {t("dashboards.edit")}
              </button>
            ) : null}
            <ToolbarMenu label={t("toolbar.more")} icon="more" entries={more} />
          </>
        )}
      </div>
    </div>
  );
}
