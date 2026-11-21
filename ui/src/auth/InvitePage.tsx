import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from "react";
import { forgetAccountData, logout, type Me, meQuery, ssoStartUrl } from "../api/auth";
import { isApiError } from "../api/client";
import { useBrand } from "../appearance/brand";
import { TextField } from "../components/TextField";
import { isBuiltInRole, roleLabel } from "../features/admin/catalog";
import { formatDateTime } from "../features/admin/components/format";
import { isPrompt, type Prompt } from "../features/security/api";
import { SecondFactorSetup } from "../features/security/SecondFactorStep";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAbove, AccessAlert, AccessEnd, AccessLayout, AccessNotice } from "./AccessLayout";
import { acceptInvitation, forgetToken, type InvitationInfo, inspectInvitation } from "./linksApi";
import { PasswordField } from "./PasswordField";
import { useLinkToken } from "./useLinkToken";
import "./auth.css";
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

/**
 * The organization the invitation is for, with the server's address: the context above the
 * heading, as on the sign-in page (board Auth.dc.html, frame 10).
 */
export function OrgChip({ name }: { name: string }) {
  const initials = name
    .split(/\s+/)
    .filter((word) => /\p{L}/u.test(word))
    .slice(0, 2)
    .map((word) => (word.match(/\p{L}/u) ?? [""])[0]?.toUpperCase())
    .join("");
  return (
    <AccessAbove>
      <p className="access__org">
        <span className="access__org-tile" aria-hidden="true">
          {initials}
        </span>
        <b className="truncate" title={name}>
          {name}
        </b>
        <span aria-hidden="true">·</span>
        <span className="access__org-server truncate">{window.location.host}</span>
      </p>
    </AccessAbove>
  );
}

/**
 * Accepting an invitation (board Auth.dc.html, frame 10; the flows of Identity.dc.html, frames 3A
 * to 3E): the invitation's facts as one quiet card, then the providers first and a name and a
 * password for a new account, or the way to join with an existing one. Expired, used, revoked
 * and mismatched links are pages of their own that say what to do next. The link's token comes
 * from the fragment and leaves the address bar at once.
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
      <AccessEnd
        tone="danger"
        icon="alert"
        title={t("access.invite.pageTitle")}
        text={
          isApiError(info.error, "rate_limited")
            ? t("access.links.rateLimited")
            : t(`errors.${isApiError(info.error) ? info.error.code : "internal"}`)
        }
        action={
          <Link to="/login" className="button button--secondary button--block">
            {t("access.invite.toSignIn")}
          </Link>
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
    <AccessEnd
      icon="link"
      title={t("access.invite.invalidTitle")}
      text={t("access.invite.invalidText")}
      action={
        <Link to="/login" className="button button--secondary button--block">
          {t("access.invite.toSignIn")}
        </Link>
      }
    />
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
      <AccessEnd
        icon="clock"
        title={t("access.invite.expiredTitle")}
        text={
          info.inviterName === null
            ? t("access.invite.expiredTextAdmin", { date: until })
            : t("access.invite.expiredText", { date: until, name: info.inviterName })
        }
        action={
          <Link to="/login" className="button button--secondary button--block">
            {t("access.invite.toSignIn")}
          </Link>
        }
      />
    );
  }
  if (info.state === "accepted") {
    return (
      <AccessEnd
        icon="check"
        title={t("access.invite.usedTitle")}
        text={t("access.invite.usedText")}
        action={
          <Link to="/login" className="button button--primary button--block">
            {t("access.invite.toSignIn")}
          </Link>
        }
      />
    );
  }

  const facts = (
    <dl className="access-facts">
      {info.inviterName === null ? null : (
        <>
          <dt>{t("access.invite.factInviter")}</dt>
          <dd>{info.inviterName}</dd>
        </>
      )}
      <dt>{t("access.invite.factRole")}</dt>
      <dd>{role}</dd>
      {info.teamName === null ? null : (
        <>
          <dt>{t("access.invite.factTeam")}</dt>
          <dd>{info.teamName}</dd>
        </>
      )}
      <dt>{t("access.invite.factUntil")}</dt>
      <dd>{until}</dd>
    </dl>
  );

  if (info.signedInAs !== null && info.signedInAs.email !== info.email) {
    return (
      <>
        <OrgChip name={info.orgName} />
        <OtherAccount info={info} />
      </>
    );
  }
  if (info.signedInAs === null && info.accountExists) {
    return (
      <>
        <OrgChip name={info.orgName} />
        <div className="access__head">
          <h1>{t("access.invite.accountExistsTitle")}</h1>
          <p className="access__lead">
            {t("access.invite.accountExistsText", { org: info.orgName })}
          </p>
        </div>
        {facts}
        {/* The token stays in this tab while signing in; the page picks it up again. */}
        <Link
          to="/login"
          search={{ redirect: "/invite" }}
          className="button button--primary button--block access__submit"
        >
          {t("access.invite.signInAndJoin")}
        </Link>
      </>
    );
  }

  // The page's context and heading; a second factor to set up first replaces them.
  const head = (
    <>
      <OrgChip name={info.orgName} />
      <div className="access__head">
        <h1>{t("access.invite.title", { product: brand.productName })}</h1>
        <p className="access__lead">{t("access.invite.lead", { org: info.orgName })}</p>
      </div>
    </>
  );
  return info.signedInAs !== null ? (
    <Join token={token} head={head} facts={facts} />
  ) : (
    <NewAccount token={token} info={info} head={head} facts={facts} />
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

function Join({ token, head, facts }: { token: string; head: ReactNode; facts: ReactNode }) {
  const { t } = useI18n();
  const joined = useJoined();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // The organization requires a second factor the account does not have: its session ended, and
  // the account sets one up before it is signed in again with the membership.
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const join = useMutation({
    mutationFn: () => acceptInvitation(token),
    retry: false,
    onSuccess: (result) => {
      if ("secondFactor" in result) {
        forgetToken("invite");
        forgetAccountData(queryClient);
        queryClient.setQueryData(meQuery.queryKey, null);
        if (isPrompt(result.secondFactor)) {
          setPrompt(result.secondFactor);
        } else {
          void navigate({ to: "/login" });
        }
        return;
      }
      return joined(result);
    },
  });
  const failed = acceptError(t, join.error);
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
  return (
    <>
      {head}
      <div className="access__form">
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        {facts}
        <button
          type="button"
          className="button button--primary button--block access__submit"
          aria-disabled={join.isPending}
          onClick={() => {
            if (!join.isPending) join.mutate();
          }}
        >
          {join.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
          {t("access.invite.join")}
        </button>
      </div>
    </>
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
  // Both ways weigh the same; nothing is chosen in advance.
  return (
    <AccessEnd
      icon="members"
      title={t("access.invite.otherAccountTitle")}
      text={t("access.invite.otherAccountText", {
        name: info.signedInAs?.email ?? "",
        email: info.email,
      })}
      action={
        <>
          <Link to="/" className="button button--secondary">
            {t("access.invite.cancel")}
          </Link>
          <button
            type="button"
            className="button button--secondary"
            aria-disabled={signOut.isPending}
            onClick={() => {
              if (!signOut.isPending) signOut.mutate();
            }}
          >
            {t("access.invite.signOutAndAccept")}
          </button>
        </>
      }
    />
  );
}

function NewAccount({
  token,
  info,
  head,
  facts,
}: {
  token: string;
  info: InvitationInfo;
  head: ReactNode;
  facts: ReactNode;
}) {
  const { t } = useI18n();
  const joined = useJoined();
  // With a provider the password form is folded behind a button, as on the sign-in page.
  const [opened, setOpened] = useState(false);
  const formShown = info.password && (info.sso.length === 0 || opened);
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (opened) nameRef.current?.focus();
  }, [opened]);
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<AccountField>>({});
  const refs = { name: nameRef, password: useRef<HTMLInputElement>(null) };
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
    <>
      {head}
      <form
        className="access__form"
        noValidate
        aria-label={t("access.invite.formLabel")}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        {facts}
        {/* Providers first, the first one as the main action: signed in through a provider with
          the invited address, the page comes back here and joins with the token alone. */}
        {info.sso.length === 0 ? null : (
          <div className="access__sso">
            {info.sso.map((provider, index) => (
              <a
                key={provider.id}
                href={ssoStartUrl(provider.id, "/invite")}
                className={
                  index === 0 && !formShown
                    ? "button button--primary button--block"
                    : "button button--secondary button--block"
                }
              >
                {t("access.invite.ssoContinue", { provider: provider.name })}
              </a>
            ))}
          </div>
        )}
        {info.password ? null : info.sso.length === 0 ? (
          <AccessNotice
            tone="info"
            icon="lock"
            title={t("access.invite.noWayTitle")}
            detail={t("access.invite.noWayText", { org: info.orgName })}
          />
        ) : (
          <p className="access__lead">{t("access.invite.ssoOnly", { org: info.orgName })}</p>
        )}
        {info.password && info.sso.length > 0 ? (
          <p className="access__or">{t("access.invite.orPassword")}</p>
        ) : null}
        {info.password && !formShown ? (
          <button
            type="button"
            className="button button--secondary button--block access__submit"
            aria-expanded={false}
            onClick={() => setOpened(true)}
          >
            {t("access.invite.withPassword")}
          </button>
        ) : null}
        {formShown ? (
          <>
            <TextField
              label={t("access.invite.email")}
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
          </>
        ) : null}
      </form>
    </>
  );
}
