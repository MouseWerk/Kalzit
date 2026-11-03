import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { forgetAccountData, logout, meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { orgQuery } from "../api/orgs";
import { EmptyState } from "../components/EmptyState";
import { fetchSecurity, securityKeys } from "../features/security/api";
import { ConfirmFactorDialog } from "../features/security/ConfirmFactorDialog";
import { useI18n } from "../i18n/i18n";
import { useCurrentOrg } from "./useOrg";

/**
 * The answers of an organization whose sign-in rules refuse this session (docs/api/access.md,
 * "Organization sign-in rules"): a second factor it requires, or a sign-in through its provider
 * instead of a password.
 */
export type OrgGateCode = Extract<
  ErrorCode,
  "org_second_factor_required" | "org_provider_sign_in_required"
>;

const GATE_CODES: readonly ErrorCode[] = [
  "org_second_factor_required",
  "org_provider_sign_in_required",
];

export function isOrgGateCode(code: ErrorCode): code is OrgGateCode {
  return GATE_CODES.includes(code);
}

/**
 * Pages that stay open while the current organization refuses the session: the account, its
 * second factor and the shortcuts, which belong to the person, not to the organization.
 */
const OPEN_PATHS = ["/settings/profile", "/settings/account-security", "/settings/shortcuts"];

export function isOpenWhileGated(pathname: string): boolean {
  return OPEN_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`));
}

/** The rule of the current organization that refuses this session, if any. */
export function useOrgGate(): OrgGateCode | undefined {
  const org = useCurrentOrg();
  const query = useQuery({ ...orgQuery(org?.id ?? ""), enabled: org !== undefined });
  const error = query.error;
  return isApiError(error) && isOrgGateCode(error.code) ? error.code : undefined;
}

/**
 * Shown in place of an organization's pages while its rules refuse the session. The other
 * organizations (the workspace menu), the account, leaving the organization and signing out stay
 * reachable; the server refuses the organization's routes either way.
 */
export function OrgGatePage({ code, orgName }: { code: OrgGateCode; orgName: string }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  // A member who has a second factor confirms it in this session; one without sets one up.
  const security = useQuery({
    queryKey: securityKeys.status,
    queryFn: fetchSecurity,
    enabled: code === "org_second_factor_required",
  });
  const [confirming, setConfirming] = useState(false);
  const signIn = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries();
      await logout();
    },
    onSuccess: () => {
      forgetAccountData(queryClient);
      queryClient.setQueryData(meQuery.queryKey, null);
      // The sign-in page lists the providers; afterwards the person is back where they were.
      const back = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
    },
  });
  const leave = (
    <Link
      to="/settings/$section"
      params={{ section: "profile" }}
      hash="organizations"
      className="button button--secondary"
    >
      {t("shell.orgGate.leave")}
    </Link>
  );
  if (code === "org_second_factor_required") {
    const status = security.data;
    const hasFactor = status !== undefined && (status.totp !== null || status.passkeys.length > 0);
    return (
      <>
        <EmptyState
          icon="lock"
          title={t("shell.orgGate.secondFactor.title")}
          actions={
            <>
              {hasFactor ? (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => setConfirming(true)}
                >
                  {t("shell.orgGate.secondFactor.confirm")}
                </button>
              ) : (
                <Link
                  to="/settings/$section"
                  params={{ section: "account-security" }}
                  className="button button--primary"
                >
                  {t("shell.orgGate.secondFactor.setUp")}
                </Link>
              )}
              {leave}
            </>
          }
        >
          {hasFactor
            ? t("shell.orgGate.secondFactor.confirmText", { name: orgName })
            : t("shell.orgGate.secondFactor.text", { name: orgName })}
        </EmptyState>
        {status !== undefined && hasFactor && confirming ? (
          <ConfirmFactorDialog
            open
            title={t("security.dialog.confirmTitle")}
            confirmLabel={t("security.factor.confirm")}
            status={status}
            onClose={() => setConfirming(false)}
            action={async () => {
              // The organization lets this session in now: its pages load again.
              setConfirming(false);
              await queryClient.invalidateQueries();
            }}
          >
            {t("shell.orgGate.secondFactor.confirmDialog", { name: orgName })}
          </ConfirmFactorDialog>
        ) : null}
      </>
    );
  }
  return (
    <EmptyState
      icon="lock"
      title={t("shell.orgGate.provider.title")}
      actions={
        <>
          <button
            type="button"
            className="button button--primary"
            disabled={signIn.isPending}
            onClick={() => signIn.mutate()}
          >
            {t("shell.orgGate.provider.signIn")}
          </button>
          {leave}
        </>
      }
    >
      {signIn.isError
        ? t(isApiError(signIn.error) ? `errors.${signIn.error.code}` : "errors.internal")
        : t("shell.orgGate.provider.text", { name: orgName })}
    </EmptyState>
  );
}
