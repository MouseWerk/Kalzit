import type { LinkProps } from "@tanstack/react-router";
import type { IconName } from "../components/Icon";
import type { MessageKey } from "../i18n/i18n";
import type { OrgPermissions } from "../org/useOrg";

/**
 * One entry of the main navigation. Each area exports its own (`features/<area>/nav.ts`) and
 * `features/nav.ts` lists them, so adding an area never edits the shell.
 */
export interface NavItem {
  to: NonNullable<LinkProps["to"]>;
  label: MessageKey;
  icon: IconName;
  /** Only the start page matches exactly; area entries stay current on their sub-pages. */
  exact?: boolean;
  /** Hides the entry without the needed permissions; absent means always shown. */
  visible?: (permissions: OrgPermissions) => boolean;
}

export const HOME_NAV: NavItem = { to: "/", label: "nav.home", icon: "home", exact: true };
