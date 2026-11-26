import type { IconName } from "../components/Icon";
import { NAV_ITEMS } from "../features/nav";
import { SECTIONS } from "../features/settings/sections";
import type { OrgPermissions } from "../org/useOrg";

/**
 * Links from the handbook into the app (`[Administration > Backups](app:/settings/backups)`,
 * decision 7): who may open the screen, by the same rules as the navigation. Only for showing the
 * button; the server checks every request of the screen anyway.
 */

/** A path of the app without its search and hash. */
function pathOf(target: string): string {
  return target.split(/[?#]/)[0]?.replace(/\/+$/, "") || "/";
}

function under(path: string, prefix: string): boolean {
  return prefix === "/" ? path === "/" : path === prefix || path.startsWith(`${prefix}/`);
}

/** Whether the person may open a screen of the app, and the icon of its area. */
export function appLinkAccess(
  target: string,
  permissions: OrgPermissions,
  orgId: string | undefined,
): { allowed: boolean; icon: IconName } {
  const path = pathOf(target);
  const settings = /^\/settings\/([\w-]+)$/.exec(path);
  if (settings !== null) {
    const section = SECTIONS.find((candidate) => candidate.id === settings[1]);
    return {
      allowed: section === undefined || section.visible({ permissions, orgId }),
      icon: "settings",
    };
  }
  // The entry of the main navigation the path lies under, and its sub-page if it has one.
  let best: { allowed: boolean; icon: IconName; length: number } | undefined;
  for (const item of NAV_ITEMS) {
    const itemAllowed = item.visible?.(permissions) ?? true;
    const candidates = [
      { to: String(item.to), allowed: itemAllowed },
      ...(item.children ?? []).map((child) => ({
        to: String(child.to),
        allowed: itemAllowed && (child.visible?.(permissions) ?? true),
      })),
    ];
    for (const candidate of candidates) {
      if (under(path, candidate.to) && (best === undefined || candidate.to.length > best.length)) {
        best = { allowed: candidate.allowed, icon: item.icon, length: candidate.to.length };
      }
    }
  }
  return best === undefined
    ? { allowed: true, icon: "arrowRight" }
    : { allowed: best.allowed, icon: best.icon };
}
