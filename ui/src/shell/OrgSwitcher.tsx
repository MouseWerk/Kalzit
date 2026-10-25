import { Link, type LinkProps } from "@tanstack/react-router";
import type { Me } from "../api/auth";
import { BrandMark } from "../appearance/BrandMark";
import { useBrand } from "../appearance/brand";
import { Icon } from "../components/Icon";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { currentOrgOf, switchOrg, useOrgPermissions } from "../org/useOrg";
import { useMenuButton } from "./useMenuButton";
import "./shellUx.css";

const BUILT_IN_ROLES = ["owner", "admin", "editor", "viewer"] as const;

interface OrgLink {
  to: NonNullable<LinkProps["to"]>;
  label: MessageKey;
}

/**
 * The workspace card on top of the sidebar: the organization's mark, its name and a chevron. It
 * opens the organization menu: who you are in it, and where its settings, members and (for a
 * server admin) the other organizations are. Without anything to open, it is a plain card.
 */
export function OrgSwitcher({ me, rail }: { me: Me; rail: boolean }) {
  const { t } = useI18n();
  const org = currentOrgOf(me);
  const permissions = useOrgPermissions();
  const menu = useMenuButton();
  const brand = useBrand();
  const name = org?.name ?? brand.productName;

  const links: OrgLink[] = [];
  if (org !== undefined && permissions.has("settings:read")) {
    links.push({ to: "/admin/settings", label: "shell.org.settings" });
  }
  if (org !== undefined && permissions.has("users:read")) {
    links.push({ to: "/admin/members", label: "shell.org.members" });
  }
  if (org !== undefined && permissions.has("teams:read")) {
    links.push({ to: "/admin/teams", label: "shell.org.teams" });
  }
  if (permissions.isServerAdmin) {
    links.push({ to: "/admin/server/organizations", label: "shell.org.all" });
  }

  const roleName =
    org === undefined
      ? null
      : BUILT_IN_ROLES.some((role) => role === org.role)
        ? t(`admin.role.${org.role as (typeof BUILT_IN_ROLES)[number]}`)
        : org.role;

  const content = (
    <>
      <span className="org-switcher__mark" aria-hidden="true">
        <BrandMark />
      </span>
      <span className="org-switcher__text">
        <span className="org-switcher__name truncate">{name}</span>
        {/* A space between the parts, so the accessible name reads as words. */}
        {roleName === null ? null : (
          <>
            {" "}
            <span className="org-switcher__role truncate">{roleName}</span>
          </>
        )}
      </span>
    </>
  );

  const others = me.orgs.length > 1;
  if (links.length === 0 && !others) {
    return (
      <div className="org-switcher org-switcher--static" title={rail ? name : undefined}>
        <span className="visually-hidden">{t("shell.org.label")}</span> {content}
      </div>
    );
  }

  return (
    <div className="menu-anchor org-switcher__anchor" ref={menu.anchorRef}>
      <button
        ref={menu.buttonRef}
        type="button"
        className="org-switcher"
        title={rail ? name : undefined}
        aria-haspopup="menu"
        aria-expanded={menu.open}
        aria-controls={menu.open ? menu.menuId : undefined}
        onClick={menu.toggle}
        onKeyDown={menu.onButtonKeyDown}
      >
        <span className="visually-hidden">{t("shell.org.label")}</span> {content}
        <Icon name="chevronUpDown" className="org-switcher__chevron" />
      </button>
      {menu.open ? (
        <div
          ref={menu.menuRef}
          id={menu.menuId}
          role="menu"
          aria-label={t("shell.org.menu")}
          className="menu menu--down"
          onKeyDown={menu.onMenuKeyDown}
        >
          <div className="menu__account">
            <span className="menu__account-name">{name}</span>
            {roleName === null ? null : (
              <span className="menu__account-email">{t("shell.org.role", { role: roleName })}</span>
            )}
          </div>
          <hr className="menu__separator" />
          {others ? (
            // biome-ignore lint/a11y/useSemanticElements: a fieldset is not allowed inside role="menu"; the ARIA menu pattern groups radio items with role="group".
            <div role="group" aria-labelledby={`${menu.menuId}-orgs`} className="menu__group">
              <div className="menu__label" id={`${menu.menuId}-orgs`}>
                {t("shell.org.switch")}
              </div>
              {me.orgs.map((option) => (
                <button
                  key={option.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={option.id === org?.id}
                  tabIndex={-1}
                  className="menu__item"
                  onClick={() => {
                    menu.closeMenu(true);
                    if (option.id !== org?.id) switchOrg(me, option.id);
                  }}
                >
                  <Icon name="check" className="menu__check" />
                  <span className="truncate">{option.name}</span>
                </button>
              ))}
            </div>
          ) : null}
          {others && links.length > 0 ? <hr className="menu__separator" /> : null}
          {links.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => menu.closeMenu(true)}
            >
              {t(link.label)}
            </Link>
          ))}
        </div>
      ) : null}
    </div>
  );
}
