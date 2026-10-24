import { HOME_NAV, type NavItem } from "../shell/navItem";
import { adminNav } from "./admin/nav";
import { dashboardsNav } from "./dashboards/nav";
import { datasourcesNav } from "./datasources/nav";
import { exploreNav } from "./explore/nav";
import { settingsNav } from "./settings/nav";

/**
 * The main navigation in display order, in groups the sidebar sets apart with a thin divider:
 * the start page, working with data, and the settings with the administration. A new area adds its entry here,
 * not in the shell.
 */
export const NAV_SECTIONS: readonly (readonly NavItem[])[] = [
  [HOME_NAV],
  [dashboardsNav, exploreNav, datasourcesNav],
  [settingsNav, adminNav],
];

export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flat();
