import type { NavItem } from "../../shell/navItem";
import { canOpenAdministration } from "./access";

export const adminNav: NavItem = {
  to: "/admin",
  label: "admin.nav",
  icon: "admin",
  visible: canOpenAdministration,
};
