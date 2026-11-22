import { Link } from "@tanstack/react-router";
import { createContext, type ReactNode, useContext, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useBrandingSync } from "../appearance/api";
import { BrandMark } from "../appearance/BrandMark";
import { useBrand } from "../appearance/brand";
import { Icon, LOGO_PATH } from "../components/Icon";
import { ToolbarMenu, type ToolbarMenuEntry } from "../components/ToolbarMenu";
import { LANGUAGES, setLanguage, useI18n } from "../i18n/i18n";
import { recordChoice } from "../lib/localChoice";
import { setTheme, THEMES, useTheme } from "../theme/theme";
import "../appearance/appearance.css";
import "./auth.css";

/** Every page before the app has the one column; only help reads better wider. */
export type AccessWidth = "narrow" | "done";

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
 * The frame of the pages before the app shell: sign in, setup, the pages behind mailed links,
 * errors and help (board Auth.dc.html, frame 2). A slim top bar with the mark, language, theme and
 * help; on wide screens the page in a column on the left and a panel on the right with the calm
 * backdrop and what the page has to say: the admin's notice where one is set, otherwise one line
 * about the product, unless the server turned it off or carries its own name or logo
 * (`signIn.productLine`); then the panel is the backdrop alone. Narrow screens and help keep one
 * centred column on the backdrop, the notice above the page.
 *
 * Every page in it has one anatomy, top to bottom: the context (`above`: organization and server,
 * the account in the second step, the steps of setup) in a row of its own, so the heading starts
 * at the same height everywhere; the heading in one size with at most one sentence; at most one
 * message; the content, standing on the page without a card; one main action; the side paths as
 * text with a link. The column is 400 px wide on every page, help excepted.
 *
 * In the source the page comes before the panel and before language, theme and help, so the
 * keyboard reaches the form first; a skip link at the very start leads there too. Language and
 * theme chosen here become the preference of the account that signs in next, where it has none.
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
  const noticed = notice !== undefined && notice !== null;
  const [aboveSlot, setAboveSlot] = useState<HTMLElement | null>(null);
  const main = useRef<HTMLElement>(null);
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
  const themes: ToolbarMenuEntry[] = THEMES.map((option) => ({
    kind: "radio",
    key: option,
    label: t(`theme.${option}`),
    checked: option === theme,
    onSelect: () => {
      setTheme(option);
      recordChoice({ theme: option });
    },
  }));

  return (
    <div className={width === "done" ? "access" : "access access--split"}>
      {/* A button, not a link to "#...": the fragment of these pages carries the links' tokens. */}
      <button type="button" className="access__skip" onClick={() => main.current?.focus()}>
        {t("access.top.skip")}
      </button>
      <header className="access__top">
        <Link to="/" className="access__brand">
          <span className="access__mark">
            <BrandMark />
          </span>
          <span className="access__product">{brand.productName}</span>
          {context === undefined ? null : <span className="access__context">{context}</span>}
        </Link>
      </header>
      <main ref={main} tabIndex={-1} className={`access__column access__column--${width}`}>
        <div className="access__above" ref={setAboveSlot}>
          {above}
        </div>
        <div className="access__flow">
          <AboveSlot value={aboveSlot}>{children}</AboveSlot>
        </div>
      </main>
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
      {/* After the page in the source, so the keyboard reaches the form first; on screen in the
          corner of the top bar. */}
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

/**
 * A message of a page: a surface with an icon and text, in the error tint for errors and neutral
 * for everything else, never a frame or a bar. It says what is, then what can be done next.
 */
export function AccessNotice({
  tone,
  icon,
  title,
  detail,
}: {
  tone: "danger" | "info";
  icon: "alert" | "clock" | "check" | "lock" | "link" | "members" | "shieldCheck" | "info";
  title: ReactNode;
  detail?: ReactNode;
}) {
  return (
    <div className={`access-notice access-notice--${tone}`}>
      <Icon name={icon} />
      <div>
        <p>{title}</p>
        {detail === undefined || detail === null ? null : (
          <p className="access-notice__detail">{detail}</p>
        )}
      </div>
    </div>
  );
}

/**
 * An end state as a page of its own (board frame 2, "Endzustände sind Seiten"): an icon on a
 * faceted tile, the heading in the size of every other page, one sentence, one action and, where
 * there is one, a side path. A link that no longer works, an inbox to check, a saved password.
 */
export function AccessEnd({
  tone = "info",
  icon,
  title,
  text,
  action,
  aside,
  status = false,
}: {
  /** "danger" tints the tile for a real error; waiting, done and used links stay neutral. */
  tone?: "danger" | "info";
  icon: "alert" | "check" | "clock" | "link" | "lock" | "members" | "info";
  title: ReactNode;
  text?: ReactNode;
  /** The one action; several only where they weigh the same ("Cancel" next to "Sign out"). */
  action?: ReactNode;
  /** A side path below the action, as text with a link. */
  aside?: ReactNode;
  /**
   * Announced when it appears (after saving or sending), not only shown. Only the heading and
   * the sentence are the live region: the actions below may tick ("Next try in 52 s"), and a
   * status around them would announce every second.
   */
  status?: boolean;
}) {
  return (
    <div className="access-end">
      <span className={`access-end__tile access-end__tile--${tone}`} aria-hidden="true">
        <Icon name={icon} />
      </span>
      <div className="access__head" role={status ? "status" : undefined}>
        <h1>{title}</h1>
        {text === undefined || text === null || text === "" ? null : (
          <p className="access__lead">{text}</p>
        )}
      </div>
      {action === undefined ? null : <div className="access-end__actions">{action}</div>}
      {aside === undefined || aside === null ? null : <p className="access__below">{aside}</p>}
    </div>
  );
}

/**
 * The steps of a flow (setup, setting up a second factor) in the row above the heading: a rhombus
 * per step, then "Step 2 of 4 · Your account". The marks are the list screen readers read, with
 * the current step as `aria-current="step"`; the line says the same to the eye.
 */
export function AccessSteps({
  names,
  current,
  label,
}: {
  names: readonly string[];
  /** The current step, counted from 1. */
  current: number;
  /** "Step 2 of 4": the list's name. */
  label: string;
}) {
  const { t } = useI18n();
  return (
    <div className="setup-steps">
      <ol className="setup-steps__list" aria-label={label}>
        {names.map((name, index) => {
          const number = index + 1;
          const state = number < current ? "done" : number === current ? "current" : "open";
          return (
            <li
              key={name}
              className={`setup-steps__item setup-steps__item--${state}`}
              aria-current={state === "current" ? "step" : undefined}
            >
              <span className="setup-steps__mark" aria-hidden="true" />
              <span className="visually-hidden">
                {name}
                {state === "done" ? t("access.setup.stepDone") : null}
              </span>
            </li>
          );
        })}
      </ol>
      <p className="setup-steps__compact" aria-hidden="true">
        {label} · <b>{names[current - 1]}</b>
      </p>
    </div>
  );
}
