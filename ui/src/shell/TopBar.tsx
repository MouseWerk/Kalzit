import { useNavigate } from "@tanstack/react-router";
import { Icon } from "../components/Icon";
import { WithTooltip } from "../components/IconButton";
import { ToolbarMenu, type ToolbarMenuEntry } from "../components/ToolbarMenu";
import { useI18n } from "../i18n/i18n";
import { useOrgPermissions } from "../org/useOrg";
import { setOverlay } from "./overlay";
import { paletteShortcut } from "./ShortcutsHelp";
import { sidebarShortcut } from "./sidebarState";
import "./shellUx.css";

/** Where the documentation lives: the project's docs folder. */
export const DOCS_URL = "https://github.com/MouseWerk/Kalzit/tree/main/docs";

interface TopBarProps {
  /** The sidebar toggle shows while the sidebar is a column. */
  wide: boolean;
  rail: boolean;
  sidebarId: string;
  onToggleSidebar: () => void;
  /** Receives the element the page's breadcrumbs are drawn into. */
  crumbSlot: (element: HTMLElement | null) => void;
}

/**
 * The bar on top of every page: the sidebar toggle and the page's trail on the left; on the
 * right the search (it opens the command palette, also with / or Ctrl+K), a New menu with what
 * the person may create, and Help. On a phone the search is an icon button.
 */
export function TopBar({ wide, rail, sidebarId, onToggleSidebar, crumbSlot }: TopBarProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const permissions = useOrgPermissions();
  const palette = paletteShortcut();
  const toggle = sidebarShortcut();

  const create: ToolbarMenuEntry[] = [];
  if (permissions.has("dashboards:write")) {
    create.push({
      key: "dashboard",
      label: t("shell.top.newDashboard"),
      icon: "dashboards",
      onSelect: () => void navigate({ to: "/dashboards", search: { create: "dashboard" } }),
    });
  }
  if (permissions.has("folders:write")) {
    create.push({
      key: "folder",
      label: t("shell.top.newFolder"),
      icon: "folder",
      onSelect: () => void navigate({ to: "/dashboards", search: { create: "folder" } }),
    });
  }
  if (permissions.has("dashboards:write")) {
    create.push({
      key: "import",
      label: t("shell.top.import"),
      icon: "download",
      onSelect: () => void navigate({ to: "/dashboards", search: { create: "import" } }),
    });
  }
  if (permissions.has("datasources:write")) {
    create.push({
      key: "datasource",
      label: t("shell.top.newDatasource"),
      icon: "dataSources",
      onSelect: () => void navigate({ to: "/data-sources/new", search: {} }),
    });
  }

  const help: ToolbarMenuEntry[] = [
    {
      key: "shortcuts",
      label: t("shell.top.shortcuts"),
      icon: "keyboard",
      shortcut: "?",
      onSelect: () => setOverlay("shortcuts"),
    },
    {
      key: "docs",
      label: t("shell.top.docs"),
      icon: "help",
      onSelect: () => {
        window.open(DOCS_URL, "_blank", "noopener,noreferrer");
      },
    },
  ];

  return (
    <div className="shell__header top-bar">
      {wide ? (
        <button
          type="button"
          className="shell__toggle"
          aria-label={t("nav.sidebar")}
          aria-expanded={!rail}
          aria-controls={sidebarId}
          aria-keyshortcuts={toggle.aria}
          title={t("nav.sidebarHint", { shortcut: toggle.label })}
          onClick={onToggleSidebar}
        >
          <Icon name="sidebar" />
        </button>
      ) : null}
      <div ref={crumbSlot} className="shell__crumbs" />
      <div className="top-bar__tools">
        <WithTooltip label={t("shell.search.hint", { shortcut: palette.label })}>
          <button
            type="button"
            className="top-bar__search"
            aria-keyshortcuts={`/ ${palette.aria}`}
            onClick={() => setOverlay("palette")}
          >
            <Icon name="search" />
            <span className="top-bar__search-label">{t("shell.top.searchPlaceholder")}</span>
            <span className="top-bar__search-key" aria-hidden="true">
              <kbd className="kbd">{palette.label}</kbd>
            </span>
          </button>
        </WithTooltip>
        {create.length === 0 ? null : (
          <ToolbarMenu
            label={t("shell.top.new")}
            icon="plus"
            text={<Icon name="chevronDown" className="top-bar__caret" />}
            className="top-bar__new"
            entries={create}
          />
        )}
        <ToolbarMenu label={t("shell.top.help")} icon="help" entries={help} />
      </div>
    </div>
  );
}
