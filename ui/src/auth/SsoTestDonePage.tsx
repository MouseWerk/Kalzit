import { useEffect } from "react";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { leavePage } from "../lib/leavePage";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessLayout } from "./AccessLayout";
import "./auth.css";

/**
 * Where a test sign-in of the administration ends (`/anmelden/sso-test`), in the window the
 * provider form opened. Nobody is signed in by it; the form shows the result. The window closes
 * itself where the browser allows it.
 */
export function SsoTestDonePage() {
  const { t } = useI18n();
  useDocumentTitle("access.ssoTest.title");
  useEffect(() => {
    leavePage.close();
  }, []);
  return (
    <AccessLayout>
      <div className="access__head">
        <h1>{t("access.ssoTest.title")}</h1>
      </div>
      <div className="access__card">
        <p className="access__ok" role="status">
          <Icon name="check" />
          <span>{t("access.ssoTest.text")}</span>
        </p>
      </div>
    </AccessLayout>
  );
}
