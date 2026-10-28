import type { MessageKey } from "../i18n/i18n";
import { HOME_NAV, type NavItem } from "../shell/navItem";
import { membersNav } from "./admin/membersNav";
import { adminNav } from "./admin/nav";
import { askNav } from "./ai/chat/nav";
import { dashboardsNav } from "./dashboards/nav";
import { datasourcesNav } from "./datasources/nav";
import { exploreNav } from "./explore/nav";
import { settingsNav } from "./settings/nav";

export interface NavSection {
  /** A small heading over the group (ORGANIZATION); a group without one is set apart by a line. */
  heading?: MessageKey;
  items: readonly NavItem[];
}

/**
 * The main navigation in display order, in groups: the start page, working with data, and the
 * organization (members, settings, the administration). A new area adds its entry here, not in
 * the shell.
 */
export const NAV_SECTIONS: readonly NavSection[] = [
  { items: [HOME_NAV] },
  { items: [dashboardsNav, exploreNav, askNav, datasourcesNav] },
  { heading: "nav.group.org", items: [membersNav, settingsNav, adminNav] },
];

export const NAV_ITEMS: readonly NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);
