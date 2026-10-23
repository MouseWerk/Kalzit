import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { logout, type Me, meQuery } from "../api/auth";
import { isApiError } from "../api/client";
import { FormAlert } from "../components/FormAlert";
import { Icon } from "../components/Icon";
import { LANGUAGES, useI18n } from "../i18n/i18n";
import { clearChoice } from "../lib/localChoice";
import { showErrorToast } from "../lib/toasts";
import { usePreferenceChange } from "../preferences/preferences";
import { THEMES, useTheme } from "../theme/theme";
import { apiErrorText } from "./shellErrors";
import { useMenuButton } from "./useMenuButton";

function initialOf(name: string): string {
  const first = Array.from(name.trim())[0];
  return first === undefined ? "?" : first.toLocaleUpperCase();
}

/**
 * Account menu with theme, language and sign out, following the WAI-ARIA menu button pattern:
 * arrow keys move between items, Home and End jump, Escape and Tab close, and focus returns to the
 * button after a choice or Escape.
 */
export function UserMenu({ me, rail = false }: { me: Me; rail?: boolean }) {
  const { t, language } = useI18n();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const themeLabelId = useId();
  const languageLabelId = useId();

  // Theme and language are preferences of the account, so they follow the user to other browsers.
  const change = usePreferenceChange(me.id, {
    onFailed: (error) => showErrorToast(apiErrorText(t, error)),
  });
  // A sign-out error from an earlier attempt is stale once the user acts again.
  const menu = useMenuButton({ onOpen: () => signOut.reset() });
  const { open, anchorRef, buttonRef, menuRef, menuId, closeMenu } = menu;
  const signOut = useMutation({
    mutationFn: logout,
    onSuccess: async () => {
      // Nothing chosen in this session passes to whoever signs in next in this browser.
      clearChoice();
      queryClient.clear();
      queryClient.setQueryData(meQuery.queryKey, null);
      await navigate({ to: "/login" });
    },
  });

  function choose(action: () => void) {
    action();
    closeMenu(true);
  }

  const signOutError =
    signOut.error === null
      ? null
      : t(isApiError(signOut.error) ? `errors.${signOut.error.code}` : "errors.internal");

  return (
    <>
      <div className="menu-anchor" ref={anchorRef}>
        <button
          ref={buttonRef}
          type="button"
          className="user-button"
          // The rail shows only the avatar; the name is the tooltip there.
          title={rail ? me.name : undefined}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          onClick={menu.toggle}
          onKeyDown={menu.onButtonKeyDown}
        >
          <span className="user-button__avatar" aria-hidden="true">
            {initialOf(me.name)}
          </span>
          <span className="user-button__text">
            <span className="user-button__name truncate">{me.name}</span>
            <span className="user-button__email truncate">{me.email}</span>
          </span>
          <span className="visually-hidden">{t("userMenu.label")}</span>
        </button>

        {open ? (
          <div
            ref={menuRef}
            id={menuId}
            role="menu"
            aria-label={t("userMenu.label")}
            className="menu"
            onKeyDown={menu.onMenuKeyDown}
          >
            {/* Who is signed in; the button shows only the initial on small screens. */}
            <div className="menu__account">
              <span className="menu__account-name">{me.name}</span>
              <span className="menu__account-email">{me.email}</span>
            </div>
            <hr className="menu__separator" />
            <MenuGroup labelId={themeLabelId} label={t("theme.label")}>
              {THEMES.map((option) => (
                <RadioItem
                  key={option}
                  checked={theme === option}
                  onSelect={() => choose(() => change.mutate({ theme: option }))}
                >
                  {t(`theme.${option}`)}
                </RadioItem>
              ))}
            </MenuGroup>
            <hr className="menu__separator" />
            <MenuGroup labelId={languageLabelId} label={t("language.label")}>
              {LANGUAGES.map((option) => (
                <RadioItem
                  key={option}
                  checked={language === option}
                  lang={option}
                  onSelect={() => choose(() => change.mutate({ language: option }))}
                >
                  {t(`language.${option}`)}
                </RadioItem>
              ))}
            </MenuGroup>
            <hr className="menu__separator" />
            {/* The own account: name, password, sessions (features/admin/account). */}
            <Link
              to="/account"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => closeMenu(true)}
            >
              {/* An empty icon slot, so the label lines up with the other items. */}
              <Icon name="check" className="menu__check" />
              {t("admin.account.title")}
            </Link>
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => {
                closeMenu(true);
                signOut.mutate();
              }}
            >
              <Icon name="signOut" />
              {t("userMenu.signOut")}
            </button>
          </div>
        ) : null}
      </div>
      {/* Outside the anchor, so a message never pushes the account button onto its own row. */}
      <FormAlert className="shell__alert">{signOutError}</FormAlert>
    </>
  );
}

function MenuGroup({
  labelId,
  label,
  children,
}: {
  labelId: string;
  label: string;
  children: ReactNode;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset is not allowed inside role="menu"; the ARIA menu pattern groups radio items with role="group".
    <div role="group" aria-labelledby={labelId} className="menu__group">
      <div id={labelId} className="menu__label">
        {label}
      </div>
      {children}
    </div>
  );
}

function RadioItem({
  checked,
  lang,
  onSelect,
  children,
}: {
  checked: boolean;
  lang?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      tabIndex={-1}
      className="menu__item"
      lang={lang}
      onClick={onSelect}
    >
      <Icon name="check" className="menu__check" />
      {children}
    </button>
  );
}
