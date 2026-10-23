import type { ReactNode } from "react";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { useI18n } from "../../i18n/i18n";
import { StarButton } from "../../shell/StarButton";
import { useWideLayout } from "../../shell/sidebarState";
import { RefreshControl } from "./RefreshControl";
import { TimeControls } from "./TimeRangePicker";
import { ToolbarMenu, type ToolbarMenuEntry } from "./ToolbarMenu";
import type { TextRange } from "./timeRange";
import "./toolbar.css";

/** What the toolbar can start; the page decides what each does. */
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
  orgId: string;
  dashboardId: string;
  title: string;
  headingId: string;
  mode: "normal" | "tv";
  /** Edit mode, and whether the draft differs from the saved dashboard. */
  editing: boolean;
  dirty: boolean;
  can: { edit: boolean; remove: boolean; access: boolean; saveAs: boolean };
  /** The playlist's controls, before the time range. */
  controls?: ReactNode;
  /** Why the range does not resolve, shown before the picker. */
  rangeError?: string | undefined;
  range: TextRange;
  onRange: (range: TextRange) => void;
  userId: string;
  dashboardZone: boolean;
  /** The time shortcuts listen while the toolbar is the page's. */
  shortcuts: boolean;
  refreshSeconds: number;
  onRefreshSeconds: (seconds: number) => void;
  refreshIntervals: readonly number[] | undefined;
  onRefresh: () => void;
  actions: ToolbarActions;
}

/**
 * The dashboard's header: the title with its star on the left; on the right the time range,
 * refresh, quiet icon buttons with tooltips and one overflow menu, and Edit as a secondary
 * button (Save is the one copper button, in edit mode). One row on wide screens; on a phone the
 * title row keeps the overflow menu and the time controls take a second row, with every other
 * action in the menu.
 */
export function DashboardToolbar({
  orgId,
  dashboardId,
  title,
  headingId,
  mode,
  editing,
  dirty,
  can,
  controls,
  rangeError,
  range,
  onRange,
  userId,
  dashboardZone,
  shortcuts,
  refreshSeconds,
  onRefreshSeconds,
  refreshIntervals,
  onRefresh,
  actions,
}: DashboardToolbarProps) {
  const { t } = useI18n();
  const wide = useWideLayout();
  const tv = mode === "tv";

  const share: ToolbarMenuEntry[] = [
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
  const view: ToolbarMenuEntry[] = [
    {
      key: "kiosk",
      label: t("dashboardTools.view.kiosk"),
      icon: "expand",
      onSelect: actions.kiosk,
    },
    { key: "tv", label: t("dashboardTools.view.tv"), icon: "screen", onSelect: actions.tv },
  ];
  const add: ToolbarMenuEntry[] = [
    { key: "panel", label: t("dashboards.addPanel"), icon: "plus", onSelect: actions.addPanel },
    { key: "row", label: t("dashboardTools.rows.add"), onSelect: actions.addRow },
    { key: "library", label: t("libraryPanels.add"), onSelect: actions.addLibraryPanel },
  ];

  const more: ToolbarMenuEntry[] = [];
  if (!wide) {
    if (editing) {
      more.push(
        {
          key: "leave",
          label: dirty ? t("dashboards.discard") : t("dashboards.doneEditing"),
          onSelect: actions.leaveEdit,
        },
        { key: "leave-sep", kind: "separator" },
        { key: "add-heading", kind: "heading", label: t("toolbar.add") },
        ...add,
        { key: "add-sep", kind: "separator" },
        {
          key: "settings",
          label: t("dashboards.settings"),
          icon: "settings",
          onSelect: actions.settings,
        },
      );
    } else if (can.edit) {
      more.push({ key: "edit", label: t("dashboards.edit"), icon: "edit", onSelect: actions.edit });
    }
    more.push(
      { key: "share-sep", kind: "separator" },
      ...share.map((entry) => ({ ...entry, key: `share-${entry.key}` })),
      ...view,
    );
  }
  if (!editing && can.edit && wide) {
    more.push({
      key: "settings",
      label: t("dashboards.settings"),
      icon: "settings",
      onSelect: actions.settings,
    });
  }
  more.push({
    key: "history",
    label: t("dashboards.versions"),
    icon: "history",
    onSelect: actions.history,
  });
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

  const time = (
    <div className="dash-toolbar__time">
      {controls}
      {rangeError === undefined ? null : <span className="field__error">{rangeError}</span>}
      <TimeControls
        value={range}
        onChange={onRange}
        userId={userId}
        dashboardZone={dashboardZone}
        shortcuts={shortcuts}
      />
      <RefreshControl
        onRefresh={onRefresh}
        seconds={refreshSeconds}
        onSeconds={onRefreshSeconds}
        intervals={refreshIntervals}
      />
    </div>
  );

  const save = (
    <button
      type="button"
      className="button button--primary"
      onClick={actions.save}
      disabled={!dirty}
    >
      {t("dashboards.save")}
    </button>
  );

  const moreMenu = tv ? null : <ToolbarMenu label={t("toolbar.more")} icon="more" entries={more} />;

  return (
    <div className={tv ? "dash-toolbar dash-toolbar--tv" : "dash-toolbar"}>
      <div className="dash-toolbar__heading">
        <h1 className="dashboard__title truncate" id={headingId}>
          {title}
        </h1>
        {tv ? null : <StarButton orgId={orgId} dashboardId={dashboardId} compact />}
        {wide ? null : (
          <span className="dash-toolbar__push">
            {editing ? save : null}
            {moreMenu}
          </span>
        )}
      </div>
      <div className="dash-toolbar__tools">
        {time}
        {tv ? (
          <button type="button" className="button button--secondary" onClick={actions.exitMode}>
            {t("dashboardTools.view.exit")}
          </button>
        ) : (
          <>
            {wide && editing ? (
              <>
                <ToolbarMenu label={t("toolbar.add")} icon="plus" entries={add} />
                <IconButton
                  icon="settings"
                  label={t("dashboards.settings")}
                  onClick={actions.settings}
                />
              </>
            ) : null}
            {wide ? (
              <>
                <ToolbarMenu label={t("toolbar.share")} icon="share" entries={share} />
                <ToolbarMenu label={t("toolbar.view")} icon="screen" entries={view} />
                {moreMenu}
              </>
            ) : null}
            {editing && wide ? (
              <>
                {/*
                 * "Done" takes the place of "Edit", so a second click on that spot leaves edit
                 * mode instead of adding a panel by accident.
                 */}
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={actions.leaveEdit}
                >
                  {dirty ? t("dashboards.discard") : t("dashboards.doneEditing")}
                </button>
                {save}
              </>
            ) : can.edit && wide ? (
              // Secondary: copper is for Save, the one main action while editing.
              <button type="button" className="button button--secondary" onClick={actions.edit}>
                <Icon name="edit" />
                {t("dashboards.edit")}
              </button>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
