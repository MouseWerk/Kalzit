import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type ReactNode, useId } from "react";
import { flushSync } from "react-dom";
import { forgetAccountData, logout, type Me, meQuery } from "../api/auth";
import { isApiError } from "../api/client";
import { FormAlert } from "../components/FormAlert";
import { Icon } from "../components/Icon";
import { LANGUAGES, useI18n } from "../i18n/i18n";
import { clearChoice } from "../lib/localChoice";
import { showErrorToast } from "../lib/toasts";
import { usePreferenceChange } from "../preferences/preferences";
import { THEMES, useTheme } from "../theme/theme";
import { mayLeave } from "./mayLeave";
import { apiErrorText } from "./shellErrors";
import { useMenuButton } from "./useMenuButton";

/** Up to two initials for the avatar: of the first and the last word, as on the blueprint. */
export function initialsOf(name: string): string {
  // Words that start with a letter, so "(de)" or "&" never gives an initial.
  const letters = name
    .trim()
    .split(/\s+/u)
    .map((word) => /^\p{L}/u.exec(word)?.[0])
    .filter((letter): letter is string => letter !== undefined)
    // One code point per initial: "ß" upper-cases to "SS", which would read as two.
    .map((letter) => Array.from(letter.toLocaleUpperCase())[0] ?? letter);
  const first = letters[0];
  const last = letters.length > 1 ? letters.at(-1) : undefined;
  return first === undefined ? "?" : `${first}${last ?? ""}`;
}

/**
 * Account menu with theme, language and sign out, following the WAI-ARIA menu button pattern:
 * arrow keys move between items, Home and End jump, Escape and Tab close, and focus returns to the
 * button after a choice or Escape.
 *
 * Signing out asks the page's leave guards first, as leaving it would, and then takes the page off
 * screen (`onLeaving`), so nothing it polls, streams or fetches on a re-render asks the server once
 * the session has ended.
 */
export function UserMenu({
  me,
  rail = false,
  onLeaving,
}: {
  me: Me;
  rail?: boolean;
  onLeaving: (leaving: boolean) => void;
}) {
  const { t, language } = useI18n();
  const theme = useTheme();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const router = useRouter();
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
    mutationFn: async (forgetBrowser: boolean) => {
      // Reads still under way are stopped first: answered after the session ended, they would
      // come back as 401 errors of a page that is being left.
      await queryClient.cancelQueries();
      await logout(forgetBrowser);
    },
    onError: (error) => {
      // An ended session is handled where every request is: the app goes to sign in itself.
      if (!isApiError(error, "unauthenticated")) {
        onLeaving(false);
      }
    },
    onSuccess: async () => {
      // The shell leaves before the cache is emptied: a component of it that renders again
      // after the cache was emptied would fetch its data anew, with the session that ended.
      await navigate({ to: "/login", search: { signedOut: true } });
      // Nothing chosen in this session passes to whoever signs in next in this browser.
      clearChoice();
      forgetAccountData(queryClient);
      queryClient.setQueryData(meQuery.queryKey, null);
    },
  });

  async function startSignOut(forgetBrowser: boolean) {
    closeMenu(true);
    // Unsaved changes on the page: its own question first; cancelled, everything stays as it is.
    if (!(await mayLeave(router, "/login"))) {
      return;
    }
    // Synchronously, so the page and its queries are gone before the request leaves.
    flushSync(() => onLeaving(true));
    signOut.mutate(forgetBrowser);
  }

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
            {initialsOf(me.name)}
          </span>
          <span className="user-button__text">
            <span className="user-button__name truncate" title={me.name}>
              {me.name}
            </span>
            <span className="user-button__email truncate" title={me.email}>
              {me.email}
            </span>
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
            {/* The own account: name, password, sessions (settings, "Profile and language"). */}
            <Link
              to="/settings/$section"
              params={{ section: "profile" }}
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
              onClick={() => void startSignOut(false)}
            >
              <Icon name="signOut" />
              {t("userMenu.signOut")}
            </button>
            {/* A shared browser: it is no longer a known device of the account either. */}
            <button
              type="button"
              role="menuitem"
              tabIndex={-1}
              className="menu__item"
              onClick={() => void startSignOut(true)}
            >
              <Icon name="check" className="menu__check" />
              {t("userMenu.signOutForget")}
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
