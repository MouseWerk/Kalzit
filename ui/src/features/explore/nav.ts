import type { NavItem } from "../../shell/navItem";

/** Explore runs free queries, which need `datasources:query`; viewers do not see it. */
export const exploreNav: NavItem = {
  to: "/explore",
  label: "explore.nav",
  icon: "explore",
  visible: (permissions) => permissions.has("datasources:query"),
};
