import type { NavItem } from "../../shell/navItem";

/**
 * Every member may open the list: it holds the sources the caller may read or query, through the
 * role or a grant on the source (docs/api/datasources.md), so a viewer with a grant finds theirs.
 */
export const datasourcesNav: NavItem = {
  to: "/data-sources",
  label: "datasources.nav",
  icon: "dataSources",
};
