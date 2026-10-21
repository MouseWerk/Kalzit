import type { OrgPermissions } from "../../org/useOrg";
import type { NavItem } from "../../shell/navItem";

/** Editors read the list to pick a source; admins also add and change sources. */
export function canSeeDatasources(permissions: OrgPermissions): boolean {
  return permissions.has("datasources:read") || permissions.has("datasources:write");
}

export const datasourcesNav: NavItem = {
  to: "/data-sources",
  label: "datasources.nav",
  icon: "dataSources",
  visible: canSeeDatasources,
};
