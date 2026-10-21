import type { NavItem } from "../../shell/navItem";
import { canOpenAdministration } from "./visibility";

export const adminNav: NavItem = {
  to: "/admin",
  label: "admin.nav",
  icon: "admin",
  visible: canOpenAdministration,
};
