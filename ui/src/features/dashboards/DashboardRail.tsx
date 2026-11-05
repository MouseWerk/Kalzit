import { type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Icon, type IconName } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { ToolbarMenu } from "../../components/ToolbarMenu";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { getPanel, panelName, useExternalPanels } from "../../panels/registry";
import { modShortcut } from "../../shell/sidebarState";
import type { ToolbarActions } from "./DashboardToolbar";
import { type PanelModel, type RowModel, readingOrder } from "./model";
import { panelIcon } from "./panelIcons";
import { useCopiedPanel } from "./panelShortcuts";
import "./toolbar.css";

/** The visualizations the Add pane offers as tiles, each with its icon. */
const TILES: readonly { type: string; icon: IconName }[] = [
  { type: "timeseries", icon: "activity" },
  { type: "bar", icon: "barChart" },
  { type: "stat", icon: "stat" },
  { type: "table", icon: "table" },
  { type: "gauge", icon: "gauge" },
  { type: "piechart", icon: "pie" },
  { type: "network", icon: "network" },
  { type: "documents", icon: "code" },
];

export type RailActions = Pick<
  ToolbarActions,
  "addRow" | "addLibraryPanel" | "settings" | "exportJson" | "copyLink" | "history" | "kiosk" | "tv"
> & {
  /** A new panel, of a type when one was chosen in the Add pane. */
  addPanel: (type?: string) => void;
  fullscreen: () => void;
  info: () => void;
  /** Adds the copied panel (Ctrl+V). */
  pastePanel: () => void;
};

interface DashboardRailProps {
  editing: boolean;
  /** Counts requests to open the Add pane (the add button at the end of the canvas). */
  addRequest?: number;
  canEdit: boolean;
  panels: readonly PanelModel[];
  rows: readonly RowModel[];
  untitled: string;
  /** Shows a panel: opens its row when it is folded, then scrolls to the panel. */
  onGoTo: (panel: PanelModel) => void;
  /** The filter bar and the annotations, which the rail shows and hides. */
  filtersShown: boolean;
  onFilters: () => void;
  annotationsShown: boolean;
  onAnnotations: () => void;
  actions: RailActions;
  /** "Pin to sidebar", from the shell (`PinButton`). */
  pin?: ReactNode;
  /** While editing: the selected panel, the inspector shown for it, and selecting from the outline. */
  selectedId?: string | null;
  inspector?: ReactNode;
  onSelect?: ((panel: PanelModel) => void) | undefined;
  rowActions?: OutlineRowActions | undefined;
}

type Pane = "outline" | "add" | null;

/**
 * The column at the canvas' right edge, in groups: the outline, the filter bar and the
 * annotations; share and export; kiosk, TV and full screen; the history and the info; at the bottom the
 * settings. While editing it starts with Add, which opens a pane of visualizations, structure and
 * what else the dashboard can hold. On wide screens it is always shown. Phones have no rail: the
 * toolbar's overflow menu holds its actions.
 */
export function DashboardRail({
  editing,
  addRequest = 0,
  canEdit,
  panels,
  rows,
  untitled,
  onGoTo,
  filtersShown,
  onFilters,
  annotationsShown,
  onAnnotations,
  actions,
  pin,
  selectedId = null,
  inspector = null,
  onSelect,
  rowActions,
}: DashboardRailProps) {
  const { t } = useI18n();
  const paneId = useId();
  const [pane, setPane] = useState<Pane>(null);
  // Selecting a panel on the canvas opens the outline, where its inspector is.
  const [shownFor, setShownFor] = useState<string | null>(null);
  if (selectedId !== shownFor) {
    setShownFor(selectedId);
    if (selectedId !== null) {
      setPane("outline");
    }
  }

  // The canvas' add button opens the Add pane and moves focus into it.
  const [seenAdd, setSeenAdd] = useState(addRequest);
  const [focusAdd, setFocusAdd] = useState(false);
  if (addRequest !== seenAdd) {
    setSeenAdd(addRequest);
    if (editing) {
      setPane("add");
      setFocusAdd(true);
    }
  }

  const paneButton = (which: Exclude<Pane, null>) => ({
    "aria-expanded": pane === which,
    "aria-controls": pane === which ? paneId : undefined,
    onClick: () => setPane((current) => (current === which ? null : which)),
  });

  return (
    <aside className="dash-rail" aria-label={t("toolbar.rail")}>
      {pane === "outline" ? (
        <Outline
          id={paneId}
          panels={panels}
          rows={rows}
          untitled={untitled}
          onGoTo={onGoTo}
          selectedId={editing ? selectedId : null}
          onSelect={editing ? onSelect : undefined}
          rowActions={editing ? rowActions : undefined}
          inspector={editing ? inspector : null}
        />
      ) : null}
      {pane === "add" && editing ? (
        <AddPane
          id={paneId}
          actions={actions}
          focus={focusAdd}
          onFocused={() => setFocusAdd(false)}
          onDone={() => setPane(null)}
        />
      ) : null}
      <div className="dash-rail__column">
        {editing ? (
          <div className="dash-rail__group">
            <IconButton icon="plus" label={t("toolbar.add")} {...paneButton("add")} />
          </div>
        ) : null}
        <div className="dash-rail__group">
          <IconButton icon="outline" label={t("toolbar.rail.outline")} {...paneButton("outline")} />
          {editing ? null : (
            <>
              <IconButton
                icon="filter"
                label={t("toolbar.rail.filters")}
                aria-pressed={filtersShown}
                onClick={onFilters}
              />
              <IconButton
                icon="flag"
                label={t("toolbar.rail.annotations")}
                aria-pressed={annotationsShown}
                onClick={onAnnotations}
              />
            </>
          )}
        </div>
        <div className="dash-rail__group">
          {editing ? null : (
            <IconButton icon="link" label={t("toolbar.rail.share")} onClick={actions.copyLink} />
          )}
          <IconButton
            icon="download"
            label={t("toolbar.rail.export")}
            onClick={actions.exportJson}
          />
        </div>
        {editing ? null : (
          <>
            <div className="dash-rail__group">
              <ToolbarMenu
                label={t("toolbar.rail.kiosk")}
                icon="screen"
                entries={[
                  {
                    key: "kiosk",
                    label: t("dashboardTools.view.kiosk"),
                    icon: "expand",
                    onSelect: actions.kiosk,
                  },
                  {
                    key: "tv",
                    label: t("dashboardTools.view.tv"),
                    icon: "screen",
                    onSelect: actions.tv,
                  },
                ]}
              />
              <IconButton
                icon="expand"
                label={t("toolbar.rail.fullscreen")}
                onClick={actions.fullscreen}
              />
            </div>
            <div className="dash-rail__group">
              {pin}
              <IconButton
                icon="history"
                label={t("toolbar.rail.history")}
                onClick={actions.history}
              />
              <IconButton icon="info" label={t("toolbar.rail.info")} onClick={actions.info} />
            </div>
          </>
        )}
        {canEdit ? (
          <div className="dash-rail__group dash-rail__group--end">
            <IconButton
              icon="settings"
              label={t("toolbar.rail.settings")}
              onClick={actions.settings}
            />
          </div>
        ) : null}
      </div>
    </aside>
  );
}

function Outline({
  id,
  panels,
  rows,
  untitled,
  onGoTo,
  selectedId,
  onSelect,
  rowActions,
  inspector,
}: {
  id: string;
  panels: readonly PanelModel[];
  rows: readonly RowModel[];
  untitled: string;
  onGoTo: (panel: PanelModel) => void;
  selectedId: string | null;
  onSelect: ((panel: PanelModel) => void) | undefined;
  rowActions: OutlineRowActions | undefined;
  inspector: ReactNode;
}) {
  const { t, language } = useI18n();
  const filterId = useId();
  const plugins = useExternalPanels();
  const [filter, setFilter] = useState("");
  const needle = filter.trim().toLocaleLowerCase(language);
  const titleOf = (panel: PanelModel) => (panel.title === "" ? untitled : panel.title);
  const matches = (panel: PanelModel) =>
    needle === "" || titleOf(panel).toLocaleLowerCase(language).includes(needle);
  const outside = readingOrder(panels.filter((p) => p.rowId === undefined && matches(p)));
  const groups = rows
    .map((row) => ({
      row,
      all: panels.filter((p) => p.rowId === row.id).length,
      panels: readingOrder(panels.filter((p) => p.rowId === row.id && matches(p))),
    }))
    .filter((group) => needle === "" || group.panels.length > 0);
  const panelButton = (panel: PanelModel) => {
    const plugin = getPanel(panel.type, plugins);
    const name = plugin === undefined ? undefined : panelName(t, plugin);
    return (
      <li key={panel.id}>
        <button
          type="button"
          className="dash-pane__item dash-pane__item--panel"
          aria-current={panel.id === selectedId ? "true" : undefined}
          data-outline-id={panel.id}
          onClick={() => (onSelect === undefined ? onGoTo(panel) : onSelect(panel))}
        >
          <Icon name={panelIcon(panel.type)} />
          <span className="truncate" title={titleOf(panel)}>
            {titleOf(panel)}
          </span>
          {name === undefined ? null : <span className="visually-hidden">{name}</span>}
          <span className="dash-pane__size" aria-hidden="true">
            {panel.grid.w}×{panel.grid.h}
          </span>
          <span className="visually-hidden">
            {t("toolbar.rail.size", { w: panel.grid.w, h: panel.grid.h })}
          </span>
        </button>
      </li>
    );
  };
  return (
    // The inspector is its own landmark next to the outline, not part of the navigation.
    <div className="dash-pane" id={id}>
      <nav className="dash-pane__outline" aria-label={t("toolbar.rail.outline")}>
        <p className="dash-pane__heading dash-pane__heading--count" aria-hidden="true">
          <span>{t("toolbar.rail.outline")}</span>
          <span className="dash-pane__count">
            {t(rows.length === 1 ? "toolbar.rail.rowOne" : "toolbar.rail.rowMany", {
              count: rows.length,
            })}
            {", "}
            {t(panels.length === 1 ? "toolbar.rail.panelOne" : "toolbar.rail.panelMany", {
              count: panels.length,
            })}
          </span>
        </p>
        {panels.length === 0 && rows.length === 0 ? (
          <p className="dash-pane__empty">{t("toolbar.rail.outlineEmpty")}</p>
        ) : (
          <>
            <div className="dash-pane__search">
              <Icon name="search" />
              <label className="visually-hidden" htmlFor={filterId}>
                {t("toolbar.rail.filterPanels")}
              </label>
              <input
                id={filterId}
                type="search"
                className="input dash-pane__search-input"
                placeholder={t("toolbar.rail.filterPanels")}
                value={filter}
                onChange={(event) => setFilter(event.currentTarget.value)}
              />
            </div>
            <ul className="dash-pane__list">
              {outside.map(panelButton)}
              {groups.map(({ row, all, panels: inRow }) => {
                const rowTitle = row.title === "" ? t("dashboardTools.rows.untitled") : row.title;
                return (
                  <li key={row.id}>
                    <div className="dash-pane__row">
                      <span className="dash-pane__row-title truncate" title={rowTitle}>
                        {rowTitle}
                      </span>
                      <span className="dash-pane__count">{all}</span>
                      {row.collapsed ? (
                        <span className="dash-pane__note">{t("toolbar.rail.collapsedRow")}</span>
                      ) : null}
                      {rowActions === undefined ? null : (
                        <span className="dash-pane__row-actions">
                          <button
                            type="button"
                            className="dash-pane__row-action"
                            aria-label={t(
                              row.collapsed ? "toolbar.rail.expandRow" : "toolbar.rail.collapseRow",
                              { title: rowTitle },
                            )}
                            onClick={() => rowActions.onToggle(row.id)}
                          >
                            <Icon name={row.collapsed ? "chevron" : "chevronDown"} />
                          </button>
                          <button
                            type="button"
                            className="dash-pane__row-action"
                            aria-label={t("dashboardTools.rows.editNamed", { title: rowTitle })}
                            title={t("dashboardTools.rows.edit")}
                            onClick={() => rowActions.onEdit(row.id)}
                          >
                            <Icon name="edit" />
                          </button>
                        </span>
                      )}
                    </div>
                    {row.collapsed && needle === "" ? null : (
                      <ul className="dash-pane__list dash-pane__list--nested">
                        {inRow.map(panelButton)}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ul>
            {needle !== "" && outside.length === 0 && groups.length === 0 ? (
              <p className="dash-pane__empty">{t("toolbar.rail.noPanelMatches")}</p>
            ) : null}
          </>
        )}
      </nav>
      {inspector}
    </div>
  );
}

/** What the outline's row headers can do while editing. */
export interface OutlineRowActions {
  onToggle: (rowId: string) => void;
  onEdit: (rowId: string) => void;
}
interface AddEntry {
  key: string;
  icon: IconName;
  label: string;
  hint: string;
  /** The shortcut that does the same, shown beside the entry. */
  keys?: string;
  onSelect: () => void;
}

/**
 * Adding while editing: visualizations as tiles (a new panel of that type), then rows and
 * text, library panels, and the variables, annotations and links of the dashboard's settings.
 * The search narrows every group.
 */
function AddPane({
  id,
  actions,
  focus,
  onFocused,
  onDone,
}: {
  id: string;
  actions: RailActions;
  /** Focus goes to the search when the pane opens. */
  focus: boolean;
  onFocused: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const searchId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const copied = useCopiedPanel();
  useEffect(() => {
    if (focus) {
      searchRef.current?.focus();
      onFocused();
    }
  }, [focus, onFocused]);
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  const run = (action: () => void) => () => {
    onDone();
    action();
  };
  const tiles = TILES.flatMap((tile) => {
    const plugin = getPanel(tile.type);
    return plugin === undefined ? [] : [{ ...tile, label: t(plugin.name) }];
  }).filter((tile) => matches(tile.label));
  const all: { key: string; title: MessageKey; entries: AddEntry[] }[] = [
    {
      key: "structure",
      title: "toolbar.add.structure",
      entries: [
        {
          key: "row",
          icon: "rows",
          label: t("toolbar.add.row"),
          hint: t("toolbar.add.rowHint"),
          onSelect: actions.addRow,
        },
        {
          key: "text",
          icon: "text",
          label: t("toolbar.add.text"),
          hint: t("toolbar.add.textHint"),
          onSelect: () => actions.addPanel("text"),
        },
      ],
    },
    {
      key: "reuse",
      title: "toolbar.add.reuse",
      entries: [
        {
          key: "library",
          icon: "library",
          label: t("toolbar.add.library"),
          hint: t("toolbar.add.libraryHint"),
          onSelect: actions.addLibraryPanel,
        },
        ...(copied === null
          ? []
          : [
              {
                key: "paste",
                icon: "paste" as const,
                label: t("toolbar.add.paste"),
                hint: t("toolbar.add.pasteHint", {
                  title:
                    copied.panel.title === "" ? t("dashboards.panel.untitled") : copied.panel.title,
                }),
                keys: modShortcut("V").label,
                onSelect: actions.pastePanel,
              },
            ]),
      ],
    },
    {
      key: "dashboard",
      title: "toolbar.add.dashboard",
      entries: [
        {
          key: "variable",
          icon: "filter",
          label: t("toolbar.add.variable"),
          hint: t("toolbar.add.variableHint"),
          onSelect: actions.settings,
        },
        {
          key: "annotations",
          icon: "flag",
          label: t("toolbar.add.annotations"),
          hint: t("toolbar.add.annotationsHint"),
          onSelect: actions.settings,
        },
        {
          key: "link",
          icon: "link",
          label: t("toolbar.add.link"),
          hint: t("toolbar.add.linkHint"),
          onSelect: actions.settings,
        },
      ],
    },
  ];
  const groups = all
    .map((group) => ({
      ...group,
      entries: group.entries.filter((e) => matches(`${e.label} ${e.hint}`)),
    }))
    .filter((group) => group.entries.length > 0);

  return (
    <section className="dash-pane dash-pane--add" id={id} aria-label={t("toolbar.add")}>
      <div className="dash-pane__header">
        <h2 className="dash-pane__name">{t("toolbar.add")}</h2>
        <span className="dash-pane__hint">{t("toolbar.add.hint")}</span>
      </div>
      <label className="visually-hidden" htmlFor={searchId}>
        {t("toolbar.add.search")}
      </label>
      <div className="time-picker__search">
        <Icon name="search" />
        <input
          ref={searchRef}
          id={searchId}
          type="search"
          className="input"
          placeholder={t("toolbar.add.search")}
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          autoComplete="off"
        />
      </div>
      {tiles.length === 0 ? null : (
        <>
          <p className="dash-pane__heading">{t("toolbar.add.visualization")}</p>
          <div className="dash-pane__tiles">
            {tiles.map((tile) => (
              <button
                key={tile.type}
                type="button"
                className="dash-pane__tile"
                onClick={run(() => actions.addPanel(tile.type))}
              >
                <Icon name={tile.icon} />
                <span className="truncate" title={tile.label}>
                  {tile.label}
                </span>
              </button>
            ))}
            {needle === "" ? (
              <button
                type="button"
                className="dash-pane__tile"
                onClick={run(() => actions.addPanel())}
              >
                <Icon name="more" />
                <span className="truncate" title={t("toolbar.add.all")}>
                  {t("toolbar.add.all")}
                </span>
              </button>
            ) : null}
          </div>
        </>
      )}
      {groups.map((group) => (
        <div key={group.key} className="dash-pane__group">
          <p className="dash-pane__heading">{t(group.title)}</p>
          <ul className="dash-pane__list">
            {group.entries.map((entry) => (
              <li key={entry.key}>
                <button type="button" className="dash-pane__entry" onClick={run(entry.onSelect)}>
                  <Icon name={entry.icon} />
                  <span className="dash-pane__entry-text">
                    <span className="dash-pane__entry-label">{entry.label}</span>
                    <span className="dash-pane__entry-hint">{entry.hint}</span>
                  </span>
                  {entry.keys === undefined ? null : (
                    <kbd className="kbd dash-pane__entry-key">{entry.keys}</kbd>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ))}
      {tiles.length === 0 && groups.length === 0 ? (
        <p className="dash-pane__empty" role="status">
          {t("toolbar.add.noMatch")}
        </p>
      ) : null}
    </section>
  );
}
