import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useEffect, useLayoutEffect } from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { useMenuButton } from "../../shell/useMenuButton";
import { DASHBOARDS_KEY, fetchDashboards } from "./api";
import { linkHref } from "./links";
import type { DashboardLinkModel, VariableValues } from "./model";
import { placeMenu } from "./VariableMultiSelect";
import "../../shell/shellUx.css";
import "./dashboardTools.css";
import "./ui/shared.css";

/** Up to this many links sit in the bar as small buttons; more go into one "Links" menu. */
const INLINE_LINKS = 2;

/**
 * The dashboard's links, below its title: addresses (variables filled in, then checked again)
 * and, per tag, the other dashboards with that tag.
 */
export function DashboardLinks({
  orgId,
  dashboardId,
  links,
  values,
}: {
  orgId: string;
  dashboardId: string;
  links: readonly DashboardLinkModel[];
  values: VariableValues;
}) {
  const { t } = useI18n();
  if (links.length === 0) {
    return null;
  }
  if (links.length > INLINE_LINKS) {
    return <LinksMenu orgId={orgId} dashboardId={dashboardId} links={links} values={values} />;
  }
  return (
    <nav className="dash-links" aria-label={t("dashboardTools.links.title")}>
      <ul className="dash-links__list">
        {links.map((link, index) => {
          if (link.type === "url") {
            const href = linkHref(link.url, values);
            // A link whose filled-in address is not allowed is left out rather than shown dead.
            return href === null ? null : (
              // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; titles can repeat
              <li key={index}>
                <a
                  className="button button--ghost button--small"
                  href={href}
                  {...(link.newTab === true
                    ? { target: "_blank", rel: "noopener noreferrer" }
                    : {})}
                >
                  {link.title}
                </a>
              </li>
            );
          }
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; tags can repeat
            <li key={index}>
              <TagLinks orgId={orgId} dashboardId={dashboardId} link={link} />
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

function TagLinks({
  orgId,
  dashboardId,
  link,
}: {
  orgId: string;
  dashboardId: string;
  link: Extract<DashboardLinkModel, { type: "dashboards" }>;
}) {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "tag", link.tag],
    queryFn: ({ signal }) => fetchDashboards(orgId, { tag: link.tag }, signal),
  });
  const others = (list.data?.items ?? []).filter((d) => d.id !== dashboardId);
  const title =
    link.title === "" ? t("dashboardTools.links.tagTitle", { tag: link.tag }) : link.title;
  return (
    <details className="dash-links__menu">
      <summary className="button button--ghost button--small">{title}</summary>
      <ul className="dash-links__dashboards">
        {others.length === 0 ? (
          <li className="field__hint">
            {list.isPending ? t("common.loading") : t("dashboardTools.links.noTagged")}
          </li>
        ) : (
          others.map((d) => (
            <li key={d.id}>
              <Link
                to="/dashboards/$dashboardId"
                params={{ dashboardId: d.id }}
                {...(link.newTab === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              >
                {d.title}
              </Link>
            </li>
          ))
        )}
      </ul>
    </details>
  );
}

/** Many links in one menu: addresses as items, a tag's dashboards under the tag's title. */
function LinksMenu({
  orgId,
  dashboardId,
  links,
  values,
}: {
  orgId: string;
  dashboardId: string;
  links: readonly DashboardLinkModel[];
  values: VariableValues;
}) {
  const { t } = useI18n();
  const menu = useMenuButton();
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;

  useLayoutEffect(() => {
    const button = buttonRef.current;
    const list = menuRef.current;
    if (!open || button === null || list === null) {
      return;
    }
    placeMenu(button, list);
  }, [open, buttonRef, menuRef]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const close = () => closeMenu(false);
    window.addEventListener("resize", close);
    return () => window.removeEventListener("resize", close);
  }, [open, closeMenu]);

  return (
    <nav className="dash-links dash-links--menu" aria-label={t("dashboardTools.links.title")}>
      <div className="menu-anchor variables__anchor" ref={anchorRef}>
        <button
          ref={buttonRef}
          type="button"
          className="button button--ghost button--small dash-links__button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={menu.toggle}
          onKeyDown={menu.onButtonKeyDown}
        >
          {t("dashboardTools.links.menu")}
          <Icon name="chevronDown" className="variables__chevron" />
        </button>
        {open
          ? createPortal(
              <div
                ref={menuRef}
                id={menuId}
                role="menu"
                aria-label={t("dashboardTools.links.title")}
                className="menu variables__menu"
                onKeyDown={(event) => {
                  if (event.key === "Tab") {
                    event.preventDefault();
                    closeMenu(true);
                    return;
                  }
                  menu.onMenuKeyDown(event);
                }}
                onPointerDown={(event) => event.stopPropagation()}
              >
                {links.map((link, index) => {
                  if (link.type === "url") {
                    const href = linkHref(link.url, values);
                    return href === null ? null : (
                      <a
                        // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; titles can repeat
                        key={index}
                        role="menuitem"
                        className="menu__item"
                        href={href}
                        onClick={() => closeMenu(false)}
                        {...(link.newTab === true
                          ? { target: "_blank", rel: "noopener noreferrer" }
                          : {})}
                      >
                        {link.title}
                      </a>
                    );
                  }
                  return (
                    <TagMenuItems
                      // biome-ignore lint/suspicious/noArrayIndexKey: links keep their order; tags can repeat
                      key={index}
                      orgId={orgId}
                      dashboardId={dashboardId}
                      link={link}
                      onPick={() => closeMenu(false)}
                    />
                  );
                })}
              </div>,
              document.body,
            )
          : null}
      </div>
    </nav>
  );
}

function TagMenuItems({
  orgId,
  dashboardId,
  link,
  onPick,
}: {
  orgId: string;
  dashboardId: string;
  link: Extract<DashboardLinkModel, { type: "dashboards" }>;
  onPick: () => void;
}) {
  const { t } = useI18n();
  const list = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "tag", link.tag],
    queryFn: ({ signal }) => fetchDashboards(orgId, { tag: link.tag }, signal),
  });
  const others = (list.data?.items ?? []).filter((d) => d.id !== dashboardId);
  const title =
    link.title === "" ? t("dashboardTools.links.tagTitle", { tag: link.tag }) : link.title;
  return (
    <>
      <div className="menu__label" role="presentation">
        {title}
      </div>
      {others.length === 0 ? (
        <div className="menu__label" role="presentation">
          {list.isPending ? t("common.loading") : t("dashboardTools.links.noTagged")}
        </div>
      ) : (
        others.map((d) => (
          <Link
            key={d.id}
            role="menuitem"
            className="menu__item"
            to="/dashboards/$dashboardId"
            params={{ dashboardId: d.id }}
            onClick={onPick}
            {...(link.newTab === true ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            {d.title}
          </Link>
        ))
      )}
    </>
  );
}
