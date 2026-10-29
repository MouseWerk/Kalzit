import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { isApiError } from "../api/client";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessLayout, AccessNotice } from "./AccessLayout";
import { confirmEmail, forgetToken } from "./linksApi";
import { useLinkToken } from "./useLinkToken";
import "./auth.css";
import "./links.css";

/**
 * The page behind an email confirmation link: confirms the account's address at once and says
 * so, or that the link no longer works.
 */
export function ConfirmEmailPage() {
  const { t } = useI18n();
  useDocumentTitle("access.confirm.pageTitle");
  const token = useLinkToken("confirm", "/confirm-email");
  const confirmed = useQuery({
    queryKey: ["email-confirmation", token],
    queryFn: async () => {
      await confirmEmail(token);
      return true;
    },
    enabled: token !== "",
    retry: false,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const done = confirmed.data === true;
  const invalid = token === "" || isApiError(confirmed.error, "not_found");
  useEffect(() => {
    if (done || invalid) forgetToken("confirm");
  }, [done, invalid]);

  let body: ReactNode = <p className="access__lead">{t("access.confirm.checking")}</p>;
  if (done || invalid) {
    body = (
      <div className="access__card link-state" role="status">
        <h1 className="link-state__title">
          {done ? t("access.confirm.doneTitle") : t("access.confirm.invalidTitle")}
        </h1>
        <p className="access__lead">
          {done ? t("access.confirm.doneText") : t("access.confirm.invalidText")}
        </p>
        <Link to="/" className="button button--primary">
          {t("access.confirm.toStart")}
        </Link>
      </div>
    );
  } else if (confirmed.error !== null) {
    body = (
      <AccessNotice
        tone="danger"
        icon="alert"
        title={
          isApiError(confirmed.error, "rate_limited")
            ? t("access.links.rateLimited")
            : t(`errors.${isApiError(confirmed.error) ? confirmed.error.code : "internal"}`)
        }
      />
    );
  }
  return <AccessLayout>{body}</AccessLayout>;
}
