import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { forgetAccountData, logout, type Me, meQuery } from "../api/auth";
import { isApiError } from "../api/client";
import { useBrand } from "../appearance/brand";
import { TextField } from "../components/TextField";
import { isBuiltInRole, roleLabel } from "../features/admin/catalog";
import { formatDateTime } from "../features/admin/components/format";
import { isPrompt, type Prompt } from "../features/security/api";
import { SecondFactorSetup } from "../features/security/SecondFactorStep";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
import { acceptInvitation, forgetToken, type InvitationInfo, inspectInvitation } from "./linksApi";
import { PasswordField } from "./PasswordField";
import { useLinkToken } from "./useLinkToken";
import "./auth.css";
import "./links.css";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  preventComposingSubmit,
  trimWhitespace,
  validateNewAccount,
} from "./validation";

type AccountField = "name" | "password";
const FIELD_ORDER: readonly AccountField[] = ["name", "password"];

/** The organization the invitation is for, with the server's address (board frame 3A). */
export function OrgChip({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => (word.match(/\p{L}/u) ?? [""])[0]?.toUpperCase())
    .join("");
  return (
    <div className="link-org">
      <span className="link-org__tile" aria-hidden="true">
        {initials}
      </span>
      <b className="link-org__name">{name}</b>
      <span className="link-org__host">{window.location.host}</span>
    </div>
  );
}

/**
 * Accepting an invitation (board docs/design/blueprint/Identity.dc.html, frames 3A to 3E): the
 * invitation's organization, role and team, then a name and a password for a new account, or
 * the way to join with an existing one. Expired, used, revoked and mismatched links each say
 * what to do next. The link's token comes from the fragment and leaves the address bar at once.
 */
export function InvitePage() {
  const { t } = useI18n();
  useDocumentTitle("access.invite.pageTitle");
  const token = useLinkToken("invite", "/invite");
  const info = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => inspectInvitation(token),
    enabled: token !== "",
    retry: false,
  });

  let body: ReactNode;
  if (token === "" || (info.error !== null && isApiError(info.error, "not_found"))) {
    body = <InvalidLink />;
  } else if (info.error !== null) {
    body = (
      <AccessNotice
        tone="danger"
        icon="alert"
        title={
          isApiError(info.error, "rate_limited")
            ? t("access.links.rateLimited")
            : t(`errors.${isApiError(info.error) ? info.error.code : "internal"}`)
        }
      />
    );
  } else if (info.data === undefined) {
    body = <p className="access__lead">{t("access.invite.loading")}</p>;
  } else {
    body = <Invitation token={token} info={info.data} />;
  }
  return <AccessLayout>{body}</AccessLayout>;
}

function InvalidLink() {
  const { t } = useI18n();
  useEffect(() => forgetToken("invite"), []);
  return (
    <div className="access__card link-state">
      <h1 className="link-state__title">{t("access.invite.invalidTitle")}</h1>
      <p className="access__lead">{t("access.invite.invalidText")}</p>
      <Link to="/login" className="button button--primary">
        {t("access.invite.toSignIn")}
      </Link>
    </div>
  );
}

function Invitation({ token, info }: { token: string; info: InvitationInfo }) {
  const { t, language, timeZone } = useI18n();
  const brand = useBrand();
  const until = formatDateTime(info.expiresAt, language, timeZone);
  // Built-in roles in the reader's language; a custom role by its name.
  const role = isBuiltInRole(info.role) ? roleLabel(t, info.role, undefined) : info.roleName;

  if (info.state === "expired") {
    return (
      <StateCard
        title={t("access.invite.expiredTitle", { date: until })}
        text={
          info.inviterName === null
            ? t("access.invite.expiredTextAdmin")
            : t("access.invite.expiredText", { name: info.inviterName })
        }
        action={
          <Link to="/login" className="button button--primary">
            {t("access.invite.toSignIn")}
          </Link>
        }
      />
    );
  }
  if (info.state === "accepted") {
    return (
      <StateCard
        title={t("access.invite.usedTitle")}
        text={t("access.invite.usedText")}
        action={
          <Link to="/login" className="button button--primary">
            {t("access.invite.signIn")}
          </Link>
        }
      />
    );
  }

  const summary = (
    <AccessNotice
      tone="info"
      icon="check"
      title={
        info.inviterName === null
          ? t("access.invite.summaryNoInviter", { org: info.orgName })
          : t("access.invite.summary", { name: info.inviterName, org: info.orgName })
      }
      detail={
        info.teamName === null
          ? t("access.invite.terms", { role, date: until })
          : t("access.invite.termsTeam", { role, team: info.teamName, date: until })
      }
    />
  );

  return (
    <>
      <OrgChip name={info.orgName} />
      <div className="access__head">
        <h1>{t("access.invite.title", { product: brand.productName })}</h1>
        <p className="access__lead">
          {info.accountExists || info.signedInAs !== null
            ? t("access.invite.leadJoin")
            : t("access.invite.lead")}
        </p>
      </div>
      {info.signedInAs !== null && info.signedInAs.email !== info.email ? (
        <OtherAccount info={info} />
      ) : info.signedInAs !== null ? (
        <Join token={token} summary={summary} />
      ) : info.accountExists ? (
        <SignInToJoin info={info} role={role} />
      ) : (
        <NewAccount token={token} info={info} summary={summary} />
      )}
    </>
  );
}

function StateCard({ title, text, action }: { title: string; text: string; action: ReactNode }) {
  return (
    <div className="access__card link-state">
      <h1 className="link-state__title">{title}</h1>
      <p className="access__lead">{text}</p>
      {action}
    </div>
  );
}

/** After joining: Start, with the organization of the invitation. */
function useJoined() {
  const queryClient = useQueryClient();
  const router = useRouter();
  return async (me: Me) => {
    forgetToken("invite");
    forgetAccountData(queryClient);
    queryClient.setQueryData(meQuery.queryKey, me);
    await router.navigate({ to: "/", replace: true });
  };
}

function acceptError(t: ReturnType<typeof useI18n>["t"], error: unknown): string | null {
  if (error === null) {
    return null;
  }
  const reason =
    isApiError(error) && typeof error.body === "object" && error.body !== null
      ? ((error.body as { error?: { reason?: string } }).error?.reason ?? "")
      : "";
  switch (reason) {
    case "mail.invite_expired":
      return t("access.invite.expiredShort");
    case "mail.invite_used":
      return t("access.invite.usedTitle");
    case "mail.invite_account_exists":
      return t("access.invite.accountExistsTitle");
    case "mail.invite_other_account":
      return t("access.invite.otherAccountShort");
    default:
      return t(`errors.${isApiError(error) ? error.code : "internal"}`);
  }
}

function Join({ token, summary }: { token: string; summary: ReactNode }) {
  const { t } = useI18n();
  const joined = useJoined();
  const join = useMutation({
    mutationFn: () => acceptInvitation(token),
    retry: false,
    // Someone signed in already passed any second step.
    onSuccess: (result) => ("secondFactor" in result ? undefined : joined(result)),
  });
  const failed = acceptError(t, join.error);
  return (
    <div className="access__card">
      {summary}
      <AccessAlert>
        {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
      </AccessAlert>
      <button
        type="button"
        className="button button--primary button--block access__submit"
        aria-disabled={join.isPending}
        onClick={() => {
          if (!join.isPending) join.mutate();
        }}
      >
        {t("access.invite.join")}
      </button>
    </div>
  );
}

function OtherAccount({ info }: { info: InvitationInfo }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const signOut = useMutation({
    mutationFn: () => logout(),
    onSuccess: async () => {
      forgetAccountData(queryClient);
      queryClient.setQueryData(meQuery.queryKey, null);
      await queryClient.invalidateQueries({ queryKey: ["invitation"] });
    },
  });
  return (
    <div className="access__card">
      <AccessNotice
        tone="info"
        icon="lock"
        title={t("access.invite.otherAccountTitle", { name: info.signedInAs?.name ?? "" })}
        detail={t("access.invite.otherAccountText", { email: info.email })}
      />
      <div className="link-actions">
        <button
          type="button"
          className="button button--primary"
          aria-disabled={signOut.isPending}
          onClick={() => {
            if (!signOut.isPending) signOut.mutate();
          }}
        >
          {t("access.invite.signOutAndAccept")}
        </button>
        <Link to="/" className="button button--secondary">
          {t("access.invite.cancel")}
        </Link>
      </div>
    </div>
  );
}

function SignInToJoin({ info, role }: { info: InvitationInfo; role: string }) {
  const { t } = useI18n();
  return (
    <div className="access__card">
      <AccessNotice
        tone="info"
        icon="lock"
        title={t("access.invite.accountExistsTitle")}
        detail={t("access.invite.accountExistsText", { org: info.orgName, role })}
      />
      {/* The token stays in this tab while signing in; the page picks it up again. */}
      <Link to="/login" search={{ redirect: "/invite" }} className="button button--primary">
        {t("access.invite.signInAndJoin")}
      </Link>
    </div>
  );
}

function NewAccount({
  token,
  info,
  summary,
}: {
  token: string;
  info: InvitationInfo;
  summary: ReactNode;
}) {
  const { t } = useI18n();
  const joined = useJoined();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<AccountField>>({});
  const refs = { name: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };
  // The second factor the organization or server requires, set up before the session opens.
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const navigate = useNavigate();
  const accept = useMutation({
    mutationFn: () => acceptInvitation(token, { name: trimWhitespace(name), password }),
    retry: false,
    onSuccess: (result) => {
      if ("secondFactor" in result) {
        // The account exists and the invitation is used; the link is done.
        forgetToken("invite");
        if (isPrompt(result.secondFactor)) {
          setPrompt(result.secondFactor);
        } else {
          // An answer this page cannot read: the account exists, so signing in continues.
          void navigate({ to: "/login" });
        }
        return;
      }
      return joined(result);
    },
    onError: (error) => {
      const field = fieldFromServer(FIELD_ORDER, error);
      if (field !== undefined) {
        setErrors({ [field]: { key: "validation.serverRejected" } });
        refs[field].current?.focus();
      }
    },
  });

  if (prompt !== null) {
    return (
      <SecondFactorSetup
        prompt={prompt}
        onSignedIn={(me) => void joined(me)}
        onSignOut={() => {
          void logout().finally(() => void navigate({ to: "/login" }));
        }}
        onExpired={() => void navigate({ to: "/login" })}
      />
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (accept.isPending) {
      return;
    }
    const found = validateNewAccount({ name, password });
    setErrors(found);
    const invalid = firstInvalid(FIELD_ORDER, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    accept.mutate();
  }

  const fieldError = (field: AccountField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };
  const failed =
    accept.error === null || fieldFromServer(FIELD_ORDER, accept.error) !== undefined
      ? null
      : acceptError(t, accept.error);

  return (
    <form
      className="access__card"
      noValidate
      aria-label={t("access.invite.formLabel")}
      onSubmit={onSubmit}
      onKeyDown={preventComposingSubmit}
    >
      {summary}
      {/* Single sign-on adds "Continue with <provider>" above the password here once it exists
          (`info.sso`, docs/api/mail.md, "Accepting"); board frame 3A. */}
      <AccessAlert>
        {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
      </AccessAlert>
      <TextField
        label={t("access.invite.email")}
        hint={t("access.invite.emailHint")}
        type="email"
        name="email"
        autoComplete="username"
        readOnly
        value={info.email}
        onValueChange={() => {}}
      />
      <TextField
        ref={refs.name}
        label={t("access.invite.name")}
        name="name"
        autoComplete="name"
        required
        readOnly={accept.isPending}
        value={name}
        onValueChange={(value) => {
          setName(value);
          setErrors(({ name: _, ...rest }) => rest);
        }}
        error={fieldError("name")}
      />
      <PasswordField
        ref={refs.password}
        label={t("access.invite.password")}
        name="new-password"
        autoComplete="new-password"
        showStrength
        showRules
        readOnly={accept.isPending}
        value={password}
        onValueChange={(value) => {
          setPassword(value);
          setErrors(({ password: _, ...rest }) => rest);
        }}
        error={fieldError("password")}
      />
      <button
        type="submit"
        className="button button--primary button--block access__submit"
        aria-disabled={accept.isPending}
      >
        {accept.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
        {t("access.invite.accept")}
      </button>
    </form>
  );
}
