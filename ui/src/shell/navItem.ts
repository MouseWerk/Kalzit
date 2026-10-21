import type { LinkProps } from "@tanstack/react-router";
import type { IconName } from "../components/Icon";
import type { MessageKey } from "../i18n/i18n";
import type { OrgPermissions } from "../org/useOrg";

/** A sub-page of a navigation entry, shown in its expandable list (or the rail's flyout). */
export interface NavChild {
  to: NonNullable<LinkProps["to"]>;
  label: MessageKey;
  /** Heading of the group the child belongs to; consecutive children share one heading. */
  group?: MessageKey;
  /** Hides the child without the needed permissions; absent means always shown. */
  visible?: (permissions: OrgPermissions) => boolean;
}

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
  /** Sub-pages; the entry becomes a disclosure that lists the visible ones. */
  children?: readonly NavChild[];
}

export const HOME_NAV: NavItem = { to: "/", label: "nav.home", icon: "home", exact: true };

/** The children the user may open, in their declared order. */
export function visibleChildren(item: NavItem, permissions: OrgPermissions): readonly NavChild[] {
  return (item.children ?? []).filter((child) => child.visible?.(permissions) ?? true);
}

export interface NavChildGroup {
  group: MessageKey | undefined;
  children: NavChild[];
}

/** Splits children into runs that share a group heading. */
export function groupChildren(children: readonly NavChild[]): NavChildGroup[] {
  const groups: NavChildGroup[] = [];
  for (const child of children) {
    const last = groups.at(-1);
    if (last !== undefined && last.group === child.group) {
      last.children.push(child);
    } else {
      groups.push({ group: child.group, children: [child] });
    }
  }
  return groups;
}

/** Whether `pathname` is the entry's page or one below it. */
export function isWithin(pathname: string, to: string): boolean {
  if (to === "/") {
    return pathname === "/";
  }
  return pathname === to || pathname.startsWith(`${to}/`);
}
