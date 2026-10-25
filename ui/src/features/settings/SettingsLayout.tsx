import { Link, Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { buildIndex, type SearchEntry, search } from "./search";
import { SECTIONS, type SectionDef, type SettingsAccess, type SettingsGroup } from "./sections";
import "./settings.css";

const GROUPS: { group: SettingsGroup; label: MessageKey }[] = [
  { group: "server", label: "settings.group.server" },
  { group: "org", label: "settings.group.org" },
  { group: "personal", label: "settings.group.personal" },
];

export function useSettingsAccess(): SettingsAccess {
  const permissions = useOrgPermissions();
  const org = useCurrentOrg();
  return { permissions, orgId: org?.id };
}

export function sectionLabel(
  t: Translate,
  section: SectionDef,
  orgName: string | undefined,
): string {
  if (section.id === "organization" && orgName !== undefined) {
    return t("settings.section.organization.label", { name: orgName });
  }
  return t(section.label);
}

/**
 * The settings page: a navigation of sections grouped Server, Organization and Personal with a
 * search across every setting, and the section on the right. Each section and each setting has
 * its own address (`/settings/appearance#appearance.accent`). On phones the navigation becomes a
 * select above the section.
 */
export function SettingsLayout() {
  const { t } = useI18n();
  const access = useSettingsAccess();
  const org = useCurrentOrg();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const visible = SECTIONS.filter((section) => section.visible(access));
  // From the address, so the sections with addresses of their own (appearance, organization) count.
  const current = pathname.split("/")[2];
  const listRef = useRef<HTMLUListElement>(null);

  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const links = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (index === -1) {
      return;
    }
    event.preventDefault();
    const next =
      links[(index + (event.key === "ArrowDown" ? 1 : -1) + links.length) % links.length];
    next?.focus();
  }

  const footer = visible.filter((section) => section.group === "footer");
  return (
    <div className="settings">
      <nav className="settings-nav" aria-label={t("settings.navLabel")}>
        <h1 className="settings-nav__title">{t("settings.title")}</h1>
        <SettingsSearch access={access} orgName={org?.name} />
        <label className="settings-nav__select field">
          <span className="field__label">{t("settings.sectionSelect")}</span>
          <select
            className="select"
            value={current ?? ""}
            onChange={(event) =>
              void navigate({
                to: "/settings/$section",
                params: { section: event.currentTarget.value },
              })
            }
          >
            {GROUPS.map(({ group, label }) => {
              const sections = visible.filter((section) => section.group === group);
              return sections.length === 0 ? null : (
                <optgroup key={group} label={t(label)}>
                  {sections.map((section) => (
                    <option key={section.id} value={section.id}>
                      {sectionLabel(t, section, org?.name)}
                    </option>
                  ))}
                </optgroup>
              );
            })}
            {footer.map((section) => (
              <option key={section.id} value={section.id}>
                {t(section.label)}
              </option>
            ))}
          </select>
        </label>
        <ul className="settings-nav__list" ref={listRef} onKeyDown={onListKey}>
          {GROUPS.map(({ group, label }) => {
            const sections = visible.filter((section) => section.group === group);
            if (sections.length === 0) {
              return null;
            }
            return (
              <li key={group} className="settings-nav__group">
                <span className="settings-nav__heading" id={`settings-group-${group}`}>
                  {t(label)}
                </span>
                <ul aria-labelledby={`settings-group-${group}`}>
                  {sections.map((section) => (
                    <li key={section.id}>
                      <Link
                        to="/settings/$section"
                        params={{ section: section.id }}
                        className="settings-nav__link"
                        aria-current={section.id === current ? "page" : undefined}
                      >
                        <span className="truncate">{sectionLabel(t, section, org?.name)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              </li>
            );
          })}
          {footer.map((section) => (
            <li key={section.id} className="settings-nav__footer">
              <Link
                to="/settings/$section"
                params={{ section: section.id }}
                className="settings-nav__link settings-nav__link--quiet"
                aria-current={section.id === current ? "page" : undefined}
              >
                {t(section.label)}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      <div className="settings-main">
        <Outlet />
      </div>
    </div>
  );
}

/**
 * The search field with its results as a list box: arrows move, Enter opens the setting (its
 * section, scrolled to the row, which is marked for a moment), Escape clears.
 */
function SettingsSearch({
  access,
  orgName,
}: {
  access: SettingsAccess;
  orgName: string | undefined;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const id = useId();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const index = buildIndex(SECTIONS, access);
  const results = search(index, query);
  const open = query.trim() !== "";

  function go(entry: SearchEntry) {
    setQuery("");
    void navigate({
      to: "/settings/$section",
      params: { section: entry.sectionId },
      ...(entry.rowId === "" ? {} : { hash: entry.rowId }),
    });
  }

  function label(entry: SearchEntry): string {
    if (entry.title === "settings.section.organization.labelPlain" && orgName !== undefined) {
      return t("settings.section.organization.label", { name: orgName });
    }
    return t(entry.title);
  }

  return (
    <div className="settings-search">
      <label className="settings-search__field">
        <Icon name="search" />
        <span className="visually-hidden">{t("settings.search.label")}</span>
        <input
          type="search"
          className="settings-search__input"
          placeholder={t("settings.search.placeholder")}
          role="combobox"
          aria-expanded={open}
          aria-controls={`${id}-results`}
          aria-autocomplete="list"
          aria-activedescendant={open && results.length > 0 ? `${id}-option-${active}` : undefined}
          value={query}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown" && results.length > 0) {
              event.preventDefault();
              setActive((active + 1) % results.length);
            } else if (event.key === "ArrowUp" && results.length > 0) {
              event.preventDefault();
              setActive((active - 1 + results.length) % results.length);
            } else if (event.key === "Enter" && !isComposingKey(event)) {
              const entry = results[active];
              if (entry !== undefined) {
                event.preventDefault();
                go(entry);
              }
            } else if (event.key === "Escape" && query !== "" && !isComposingKey(event)) {
              event.preventDefault();
              event.stopPropagation();
              setQuery("");
            }
          }}
        />
      </label>
      <div className="settings-search__popup" hidden={!open}>
        <div
          id={`${id}-results`}
          role="listbox"
          aria-label={t("settings.search.results")}
          className="settings-search__results"
        >
          {results.map((entry, i) => (
            // biome-ignore lint/a11y/useKeyWithClickEvents: the search field handles the keys (combobox)
            <div
              key={`${entry.sectionId}#${entry.rowId}`}
              id={`${id}-option-${i}`}
              role="option"
              tabIndex={-1}
              aria-selected={i === active}
              className="settings-search__result"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => go(entry)}
            >
              <span className="settings-search__title">{label(entry)}</span>
              {entry.rowId === "" ? null : (
                <span className="settings-search__section">
                  {entry.section === "settings.section.organization.labelPlain" &&
                  orgName !== undefined
                    ? t("settings.section.organization.label", { name: orgName })
                    : t(entry.section)}
                </span>
              )}
            </div>
          ))}
        </div>
        {open && results.length === 0 ? (
          <p className="settings-search__none" role="status">
            {t("settings.search.none", { query: query.trim() })}
          </p>
        ) : null}
      </div>
    </div>
  );
}
