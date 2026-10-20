import type { ReactNode } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { PreferenceSelects } from "../shell/PreferenceSelects";

/** Centered card for the pages shown before the app shell: sign in and setup. */
export function AuthLayout({
  title,
  lead,
  children,
}: {
  title: string;
  lead: string;
  children: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <main className="auth">
      <div className="auth__card">
        <div className="auth__brand">
          <Icon name="logo" />
          <span>{t("app.name")}</span>
        </div>
        <div className="auth__header">
          <h1>{title}</h1>
          <p className="auth__lead">{lead}</p>
        </div>
        <div className="auth__panel">{children}</div>
        <PreferenceSelects />
      </div>
    </main>
  );
}
