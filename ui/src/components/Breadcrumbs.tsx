import { Link, type LinkProps } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";
import { useCrumbSlot } from "../shell/shellContext";
import "../shell/shellUx.css";

export interface Crumb {
  label: string;
  /** Where the crumb leads; the last crumb is the current page and has none. */
  link?: LinkProps | undefined;
}

/**
 * Where the page lies: a trail of links up to the current page, which is named last and marked
 * with `aria-current`. The page's own heading stays the h1. Inside the app shell the trail sits
 * in the content header, right after the sidebar toggle; elsewhere where it is rendered.
 */
export function Breadcrumbs({
  crumbs,
  extra,
}: {
  crumbs: readonly Crumb[];
  /** A control right after the current page's name (the dashboard's star). */
  extra?: ReactNode;
}) {
  const { t } = useI18n();
  const slot = useCrumbSlot();
  if (crumbs.length === 0) {
    return null;
  }
  const nav = (
    <nav className="breadcrumbs" aria-label={t("shell.breadcrumbs")}>
      <ol className="breadcrumbs__list">
        {crumbs.map((crumb, index) => {
          const last = index === crumbs.length - 1;
          return (
            // Labels repeat (two folders of one name), positions do not.
            // biome-ignore lint/suspicious/noArrayIndexKey: the trail is rebuilt as a whole.
            <li key={index} className="breadcrumbs__item">
              {crumb.link === undefined || last ? (
                <span
                  className="breadcrumbs__current truncate"
                  aria-current={last ? "page" : undefined}
                >
                  {crumb.label}
                </span>
              ) : (
                <Link {...crumb.link} className="breadcrumbs__link truncate">
                  {crumb.label}
                </Link>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
  // A control after the trail stays outside the navigation landmark, which holds links only.
  const trail =
    extra === undefined ? (
      nav
    ) : (
      <div className="breadcrumbs-row">
        {nav}
        {extra}
      </div>
    );
  return slot === null ? trail : createPortal(trail, slot);
}

/** Folder names from the top down to `folderId`, from a flat folder list. */
export function folderTrail<T extends { id: string; parentId: string | null; name: string }>(
  folders: readonly T[],
  folderId: string | null | undefined,
): T[] {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const trail: T[] = [];
  let next = folderId == null ? undefined : byId.get(folderId);
  while (next !== undefined && !trail.includes(next) && trail.length < 64) {
    trail.unshift(next);
    next = next.parentId === null ? undefined : byId.get(next.parentId);
  }
  return trail;
}
