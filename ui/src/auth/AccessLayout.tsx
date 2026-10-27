import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";
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

export type AccessWidth = "narrow" | "wide" | "done";

/** The guide page the Help link opens; the help pages ship with Kalzit (see help/HelpPage). */
export const HELP_PAGE = "getting-started";

/**
 * The frame of the pages before the app shell: sign in, setup and help. A slim top bar with the
 * mark, language, theme and help; one centred column on the calm backdrop; the license line at
 * the bottom. Language and theme chosen here become the preference of the account that signs in
 * next, where it has none.
 */
export function AccessLayout({
  context,
  width = "narrow",
  helpInNewTab = false,
  children,
}: {
  /** A word next to the mark, such as "Setup". */
  context?: string | undefined;
  width?: AccessWidth;
  /** Opens help in a new tab, so a half-filled form stays (setup). */
  helpInNewTab?: boolean;
  children: ReactNode;
}) {
  const { t, language } = useI18n();
  // Product name, logo and default theme from the server's appearance settings.
  useBrandingSync();
  const brand = useBrand();
  const theme = useTheme();

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
    <div className="access">
      <Backdrop />
      <header className="access__top">
        <Link to="/" className="access__brand" aria-label={brand.productName}>
          <span className="access__mark">
            <BrandMark />
          </span>
          <span className="access__product" aria-hidden="true">
            {brand.productName}
          </span>
          {context === undefined ? null : (
            <span className="access__context" aria-hidden="true">
              {context}
            </span>
          )}
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
      <main className={`access__column access__column--${width}`}>{children}</main>
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
}: {
  tone: "danger" | "info";
  icon: "alert" | "clock" | "check" | "lock";
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
