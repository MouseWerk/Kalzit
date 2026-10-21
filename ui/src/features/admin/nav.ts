import type { MessageKey } from "../../i18n/i18n";
import type { NavChild, NavItem } from "../../shell/navItem";
import { type AdminSectionLink, ORG_SECTIONS, SERVER_SECTIONS } from "./sections";
import { canOpenAdministration } from "./visibility";

function sectionChildren(sections: readonly AdminSectionLink[], group: MessageKey): NavChild[] {
  return sections.map(({ to, label, visible }) => ({ to, label, group, visible }));
}

/** The administration with its sections as sub-pages, each shown only to who may open it. */
export const adminNav: NavItem = {
  to: "/admin",
  label: "admin.nav",
  icon: "admin",
  visible: canOpenAdministration,
  childrenLabel: "admin.sections",
  children: [
    ...sectionChildren(ORG_SECTIONS, "admin.group.org"),
    ...sectionChildren(SERVER_SECTIONS, "admin.group.server"),
  ],
};
