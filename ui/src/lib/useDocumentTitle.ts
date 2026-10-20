import { useEffect } from "react";
import { type MessageKey, useI18n } from "../i18n/i18n";

/** Sets the window title to "<page> – Granit" in the current language. */
export function useDocumentTitle(page: MessageKey): void {
  const { t } = useI18n();
  const title = t("app.documentTitle", { page: t(page) });
  useEffect(() => {
    document.title = title;
  }, [title]);
}
