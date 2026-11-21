import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useState } from "react";
import { createPortal } from "react-dom";
import { useBrandingSync } from "../appearance/api";
import { BrandMark } from "../appearance/BrandMark";
import { useBrand } from "../appearance/brand";
import { Icon, LOGO_PATH } from "../components/Icon";
import { ToolbarMenu, type ToolbarMenuEntry } from "../components/ToolbarMenu";
import { LANGUAGES, setLanguage, useI18n } from "../i18n/i18n";
import { recordChoice } from "../lib/localChoice";
import {
  DARK_VARIANTS,
  LIGHT_VARIANTS,
  setDarkVariant,
  setLightVariant,
  setTheme,
  THEMES,
  useDarkVariant,
  useLightVariant,
  useTheme,
} from "../theme/theme";
import "../appearance/appearance.css";
import "./auth.css";
import "./links.css";

export type AccessWidth = "narrow" | "wide" | "done";

/** The guide page the Help link opens; the help pages ship with Kalzit (see help/HelpPage). */
export const HELP_PAGE = "getting-started";

/**
 * The row above the heading of the layout around: undefined outside a layout, null until the row
 * is in the page.
 */
const AboveSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * Puts its children into the row above the heading, for a page part deeper inside the layout
 * (the steps of the second factor's setup); the page itself passes `above` to the layout.
 */
export function AccessAbove({ children }: { children: ReactNode }) {
  const slot = useContext(AboveSlot);
  if (slot === undefined) {
    return children;
  }
  return slot === null ? null : createPortal(children, slot);
}

/**
 * The frame of the pages before the app shell: sign in, setup and help. A slim top bar with the
 * mark, language, theme and help; the form in a column on the left and, on wide screens, a panel
 * on the right with the calm backdrop and what the page has to say: the admin's notice where one
 * is set, otherwise one line about the product, unless the server turned it off or carries its
 * own name or logo (`signIn.productLine`); then the panel is the backdrop alone. Narrow screens and the widest pages ("done") keep
 * one centred column on the backdrop, the notice above the form. What a page shows above its
 * heading (`above`) has a row of its own, so the heading starts at the same height on every page
 * and the notice in the panel starts in the heading's row. Language and theme chosen here become
 * the preference of the account that signs in next, where it has none.
 */
export function AccessLayout({
  context,
  width = "narrow",
  helpInNewTab = false,
  above,
  notice,
  children,
}: {
  /** A word next to the mark, such as "Setup". */
  context?: string | undefined;
  width?: AccessWidth;
  /** Opens help in a new tab, so a half-filled form stays (setup). */
  helpInNewTab?: boolean;
  /** What stands above the heading: the organization and server, or the steps of setup. */
  above?: ReactNode;
  /** The admin's notice for everyone who signs in; it takes the panel's place of the product line. */
  notice?: ReactNode;
  children: ReactNode;
}) {
  const { t, language } = useI18n();
  // Product name, logo and default theme from the server's appearance settings.
  const branding = useBrandingSync();
  const brand = useBrand();
  const theme = useTheme();
  const lightVariant = useLightVariant();
  const darkVariant = useDarkVariant();
  const noticed = notice !== undefined && notice !== null;
  const [aboveSlot, setAboveSlot] = useState<HTMLElement | null>(null);
  const productLine = !noticed && branding?.signIn.productLine === true;
  // With nothing to say the panel is decoration, not a landmark. One element either way, so the
  // backdrop is not built anew once the server's answer says which it is.
  // The role and its name come together: a name without a role says nothing.
  const landmark = noticed
    ? { role: "complementary", "aria-label": t("access.panel.noticeLabel") }
    : productLine
      ? {
          role: "complementary",
          "aria-label": t("access.panel.aboutLabel", { product: brand.productName }),
        }
      : {};

  const languages: ToolbarMenuEntry[] = LANGUAGES.map((option) => ({
    kind: "radio",
    key: option,
    label: t(`language.${option}`),
    checked: option === language,
    onSelect: () => {
      setLanguage(option);
      recordChoice({ language: option });
    },
  }));
  // The mode, then one light and one dark variant (board Themes, frame 7). Chosen here, they
  // hold for this browser and become the account's choice on signing in.
  const themes: ToolbarMenuEntry[] = [
    { kind: "heading", key: "mode-heading", label: t("theme.mode") },
    ...THEMES.map(
      (option): ToolbarMenuEntry => ({
        kind: "radio",
        key: option,
        label: t(`theme.${option}`),
        checked: option === theme,
        onSelect: () => {
          setTheme(option);
          recordChoice({ theme: option });
        },
      }),
    ),
    { kind: "separator", key: "light-separator" },
    { kind: "heading", key: "light-heading", label: t("theme.lightVariant") },
    ...LIGHT_VARIANTS.map(
      (option): ToolbarMenuEntry => ({
        kind: "radio",
        key: `light-${option}`,
        label: t(`theme.variant.${option}`),
        checked: option === lightVariant,
        onSelect: () => {
          setLightVariant(option);
          recordChoice({ themeLight: option });
        },
      }),
    ),
    { kind: "separator", key: "dark-separator" },
    { kind: "heading", key: "dark-heading", label: t("theme.darkVariant") },
    ...DARK_VARIANTS.map(
      (option): ToolbarMenuEntry => ({
        kind: "radio",
        key: `dark-${option}`,
        label: t(`theme.variant.${option}`),
        checked: option === darkVariant,
        onSelect: () => {
          setDarkVariant(option);
          recordChoice({ themeDark: option });
        },
      }),
    ),
  ];

  return (
    <div className={width === "done" ? "access" : "access access--split"}>
      <header className="access__top">
        <Link to="/" className="access__brand">
          <span className="access__mark">
            <BrandMark />
          </span>
          <span className="access__product">{brand.productName}</span>
          {context === undefined ? null : <span className="access__context">{context}</span>}
        </Link>
        <div className="access__tools">
          <ToolbarMenu
            label={t("access.top.language", { language: t(`language.${language}`) })}
            icon="globe"
            text={t(`language.${language}`)}
            entries={languages}
            className="access__tool"
          />
          <ToolbarMenu
            label={t("access.top.theme", { theme: t(`theme.${theme}`) })}
            icon="screen"
            text={t(`theme.${theme}`)}
            entries={themes}
            className="access__tool"
          />
          <Link
            to="/help/$page"
            params={{ page: HELP_PAGE }}
            className="button button--ghost icon-button access__tool"
            aria-label={t("access.top.help")}
            {...(helpInNewTab ? { target: "_blank", rel: "noopener" } : {})}
          >
            <Icon name="help" />
            <span className="icon-button__text">{t("access.top.help")}</span>
          </Link>
        </div>
      </header>
      <div className="access__panel" {...landmark}>
        <Backdrop />
        {noticed ? (
          <div className="access__panel-body">
            <div className="access__notice" role="note">
              <Icon name="info" />
              {notice}
            </div>
          </div>
        ) : productLine ? (
          <div className="access__panel-body">
            <div className="access__say">
              <p className="access__say-title">{t("access.panel.title")}</p>
              <p className="access__say-text">{t("access.panel.text")}</p>
            </div>
          </div>
        ) : null}
      </div>
      <main className={`access__column access__column--${width}`}>
        <div className="access__above" ref={setAboveSlot}>
          {above}
        </div>
        <div className="access__flow">
          <AboveSlot value={aboveSlot}>{children}</AboveSlot>
        </div>
      </main>
      <p className="access__fine">{t("access.fineprint")}</p>
    </div>
  );
}

/**
 * The calm backdrop: a fine grid and the edge of a calcite crystal, faint, with a soft light that
 * drifts across in half a minute and lifts both where it falls. Only `transform` moves, in CSS;
 * the light stands still for reduced motion, and phones and the contrast theme have none.
 */
function Backdrop() {
  return (
    <div className="access-bd" aria-hidden="true">
      <div className="access-bd__layer access-bd__layer--base">
        <Crystal />
      </div>
      <div className="access-bd__lamp">
        <div className="access-bd__layer access-bd__layer--lit">
          <Crystal />
        </div>
      </div>
    </div>
  );
}

function Crystal() {
  return (
    <svg className="access-bd__crystal" viewBox="0 0 24 24" focusable="false" aria-hidden="true">
      <path d={LOGO_PATH} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * The error region of a form. It stays mounted while the form is shown, because screen readers
 * only announce changes inside a region that already existed.
 */
export function AccessAlert({ children }: { children: ReactNode }) {
  return (
    <div className="access__alert" role="alert" aria-atomic="true">
      {children}
    </div>
  );
}

/** A form's own error and status notices: tinted fill and icon, never a frame. */
export function AccessNotice({
  tone,
  icon,
  title,
  detail,
  heading = false,
}: {
  tone: "danger" | "info";
  icon: "alert" | "clock" | "check" | "lock" | "link" | "members" | "shieldCheck";
  title: ReactNode;
  detail?: ReactNode;
  /** The notice is what the page says (an end state of a link): its title is the page's heading. */
  heading?: boolean;
}) {
  return (
    <div className={`access-notice access-notice--${tone}`}>
      <Icon name={icon} />
      <div>
        {heading ? <h1 className="access-notice__title">{title}</h1> : <p>{title}</p>}
        {detail === undefined || detail === null ? null : (
          <p className="access-notice__detail">{detail}</p>
        )}
      </div>
    </div>
  );
}

/**
 * An end state of a link (expired, used, unknown, saved; board frames 3C and 3D): the notice says
 * what happened and is the page's heading, one button below it says what to do.
 */
export function LinkState({
  tone,
  icon,
  title,
  text,
  action,
  status = false,
}: {
  tone: "danger" | "info";
  icon: "check" | "clock" | "link";
  title: string;
  text: string;
  action: ReactNode;
  /** Announced when it appears (after saving), not only shown. */
  status?: boolean;
}) {
  return (
    <div className="access__card link-state" role={status ? "status" : undefined}>
      <AccessNotice tone={tone} icon={icon} title={title} detail={text} heading />
      {action}
    </div>
  );
}
