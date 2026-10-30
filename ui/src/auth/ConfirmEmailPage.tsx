import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type ReactNode, useEffect } from "react";
import { meQuery } from "../api/auth";
import { isApiError } from "../api/client";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
import { confirmEmail, forgetToken } from "./linksApi";
import { useLinkToken } from "./useLinkToken";
import "./auth.css";
import "./links.css";

/**
 * The page behind an email confirmation link. Confirming needs the account the link was made
 * for, signed in: the page sends everyone else to sign in first (the link's token waits in this
 * tab), names the account, and confirms only on an explicit click.
 */
export function ConfirmEmailPage() {
  const { t } = useI18n();
  useDocumentTitle("access.confirm.pageTitle");
  const token = useLinkToken("confirm", "/confirm-email");
  const me = useQuery(meQuery);
  const confirm = useMutation({ mutationFn: () => confirmEmail(token), retry: false });
  const done = confirm.isSuccess;
  const invalid = token === "" || isApiError(confirm.error, "not_found");
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
  } else if (me.data === null) {
    body = (
      <div className="access__card link-state">
        <h1 className="link-state__title">{t("access.confirm.signInTitle")}</h1>
        <p className="access__lead">{t("access.confirm.signInText")}</p>
        <Link
          to="/login"
          search={{ redirect: "/confirm-email" }}
          className="button button--primary"
        >
          {t("access.confirm.signIn")}
        </Link>
      </div>
    );
  } else if (me.data !== undefined) {
    const failed =
      confirm.error === null
        ? null
        : isApiError(confirm.error, "rate_limited")
          ? t("access.links.rateLimited")
          : t(`errors.${isApiError(confirm.error) ? confirm.error.code : "internal"}`);
    body = (
      <div className="access__card link-state">
        <h1 className="link-state__title">{t("access.confirm.title")}</h1>
        <p className="access__lead">
          {t("access.confirm.forAccount", { email: me.data.email, name: me.data.name })}
        </p>
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        <button
          type="button"
          className="button button--primary"
          aria-disabled={confirm.isPending}
          onClick={() => {
            if (!confirm.isPending) confirm.mutate();
          }}
        >
          {t("access.confirm.confirm")}
        </button>
      </div>
    );
  }
  return <AccessLayout>{body}</AccessLayout>;
}
