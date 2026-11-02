import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { forgetAccountData, logout, meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { orgQuery } from "../api/orgs";
import { EmptyState } from "../components/EmptyState";
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
    return (
      <EmptyState
        icon="lock"
        title={t("shell.orgGate.secondFactor.title")}
        actions={
          <>
            <Link
              to="/settings/$section"
              params={{ section: "account-security" }}
              className="button button--primary"
            >
              {t("shell.orgGate.secondFactor.setUp")}
            </Link>
            {leave}
          </>
        }
      >
        {t("shell.orgGate.secondFactor.text", { name: orgName })}
      </EmptyState>
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
