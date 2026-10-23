import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { PreferenceSelects } from "../shell/PreferenceSelects";
import { ShapesIllustration } from "./ShapesIllustration";
import "./auth.css";

/**
 * The frame of the pages shown before the app shell: sign in and setup. On wide screens a quiet
 * brand panel (mark, product line, a monochrome drawing of the three result shapes) stands next to
 * the form; on narrow ones only the mark stays above it. Language and theme sit in one row under
 * the form.
 */
export function AuthLayout({
  title,
  lead,
  wide = false,
  children,
}: {
  title: string;
  lead: string;
  /** A wider form column, for the setup form's groups. */
  wide?: boolean;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="auth">
      <aside className="auth__aside" aria-label={t("auth.aboutLabel")}>
        <div className="auth__brand">
          <span className="auth__mark">
            <Icon name="logo" />
          </span>
          <span>{t("app.name")}</span>
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
            <p className="auth__lead">{lead}</p>
          </div>
          <div className="auth__panel">{children}</div>
        </div>
        <PreferenceSelects />
      </main>
    </div>
  );
}
