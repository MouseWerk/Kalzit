import { HOME_NAV, type NavItem } from "../shell/navItem";
import { adminNav } from "./admin/nav";
import { dashboardsNav } from "./dashboards/nav";
import { datasourcesNav } from "./datasources/nav";
import { exploreNav } from "./explore/nav";

/** The main navigation in display order. A new area adds its entry here, not in the shell. */
export const NAV_ITEMS: readonly NavItem[] = [
  HOME_NAV,
  dashboardsNav,
  exploreNav,
  datasourcesNav,
  adminNav,
];
