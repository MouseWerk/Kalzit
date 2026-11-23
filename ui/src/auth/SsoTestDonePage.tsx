import { useEffect } from "react";
import { useI18n } from "../i18n/i18n";
import { leavePage } from "../lib/leavePage";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessEnd, AccessLayout } from "./AccessLayout";
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
      <AccessEnd
        icon="check"
        title={t("access.ssoTest.title")}
        text={t("access.ssoTest.text")}
        status
      />
    </AccessLayout>
  );
}
