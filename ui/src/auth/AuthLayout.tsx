import type { ReactNode } from "react";
import { useBrandingSync } from "../appearance/api";
import { BrandMark } from "../appearance/BrandMark";
import { useBrand } from "../appearance/brand";
import { LimitedMarkdown } from "../appearance/LimitedMarkdown";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { PreferenceSelects } from "../shell/PreferenceSelects";
import { ShapesIllustration } from "./ShapesIllustration";
import "../appearance/appearance.css";
import "./auth.css";

/**
 * The frame of the pages shown before the app shell: sign in and setup. On wide screens a quiet
 * brand panel (mark, product line, a monochrome drawing of the three result shapes) stands next to
 * the form; on narrow ones only the mark stays above it. Language and theme sit in one row under
 * the form. The product name, logo and look come from the server's appearance settings; the
 * sign-in page also shows the admin's welcome text and notice (`signInTexts`).
 */
export function AuthLayout({
  title,
  lead,
  wide = false,
  signInTexts = false,
  children,
}: {
  title: string;
  lead: string;
  /** A wider form column, for the setup form's groups. */
  wide?: boolean;
  /** Shows the welcome text and notice an admin set for the sign-in page. */
  signInTexts?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  const branding = useBrandingSync();
  const brand = useBrand();
  const welcome = signInTexts ? (branding?.signIn.welcome.trim() ?? "") : "";
  const notice = signInTexts ? (branding?.signIn.notice.trim() ?? "") : "";
  return (
    <div className="auth">
      <aside className="auth__aside" aria-label={t("auth.aboutLabel")}>
        <div className="auth__brand">
          <span className="auth__mark">
            <BrandMark />
          </span>
          <span>{brand.productName}</span>
        </div>
        <div className="auth__story">
          <div className="auth__pitch">
            <p className="auth__tagline">{t("auth.tagline")}</p>
            <p className="auth__pitch-lead">{t("auth.pitch")}</p>
          </div>
          <ShapesIllustration />
        </div>
        <p className="auth__fineprint">{t("auth.fineprint")}</p>
      </aside>
      <main className="auth__main">
        <div className={wide ? "auth__column auth__column--wide" : "auth__column"}>
          <div className="auth__header">
            <h1>{title}</h1>
            {welcome === "" ? (
              <p className="auth__lead">{lead}</p>
            ) : (
              <LimitedMarkdown text={welcome} className="auth__lead limited-markdown" />
            )}
          </div>
          {notice === "" ? null : (
            <div className="notice auth__admin-notice" role="note">
              <Icon name="alert" />
              <LimitedMarkdown text={notice} className="limited-markdown" />
            </div>
          )}
          <div className="auth__panel">{children}</div>
        </div>
        <PreferenceSelects />
      </main>
    </div>
  );
}
