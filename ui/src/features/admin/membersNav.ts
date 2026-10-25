import type { NavItem } from "../../shell/navItem";

/** The organization's members, a shortcut into the administration for who may read them. */
export const membersNav: NavItem = {
  to: "/admin/members",
  label: "nav.members",
  icon: "members",
  visible: (permissions) => permissions.has("users:read"),
};
