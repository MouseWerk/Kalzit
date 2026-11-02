import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useRouter } from "@tanstack/react-router";
import {
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  forgetAccountData,
  type LoginInput,
  login,
  loginLocal,
  logout,
  type Me,
  meQuery,
  type SignInProvider,
  signInProvidersQuery,
  ssoStartUrl,
} from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import type { LoginSearch } from "../app/baseRoutes";
import { useBrandingSync } from "../appearance/api";
import { LimitedMarkdown } from "../appearance/LimitedMarkdown";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { errorReason } from "../features/datasources/reasons";
import { fetchPrompt, isPrompt, type Prompt } from "../features/security/api";
import {
  LinkPasswordStep,
  SecondFactorSetup,
  SecondFactorStep,
} from "../features/security/SecondFactorStep";
import { type Translate, useI18n } from "../i18n/i18n";
import { leavePage } from "../lib/leavePage";
import { readPreference, writePreference } from "../lib/storage";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
import { formatWait, useCountdown, waitUntil } from "./countdown";
import { PasswordField } from "./PasswordField";
import { SSO_OUTCOMES, type SsoOutcome } from "./ssoOutcome";
import "./auth.css";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  type LoginField,
  preventComposingSubmit,
  trimWhitespace,
  validateLogin,
} from "./validation";

const FIELD_ORDER: readonly LoginField[] = ["email", "password"];
const loginRoute = getRouteApi("/login");
const localRoute = getRouteApi("/anmelden/lokal");

/** Whether this browser opened the folded password form last time ("Sign in with password"). */
const PASSWORD_OPEN_KEY = "kalzit.signIn.passwordOpen";

/** The reason of `POST /auth/login` when password sign-in is off for the account. */
const PASSWORD_OFF = "sso.password_sign_in_off";
/** A directory could not be reached and no local account matched (docs/api/sso.md, LDAP). */
const DIRECTORY_UNREACHABLE = "ldap.directory_unreachable";
/** The directory confirmed the person, but Kalzit refuses the sign-in; `outcome` says why. */
const DIRECTORY_REFUSED = "ldap.sign_in_refused";

function isSsoOutcome(value: string | undefined): value is SsoOutcome {
  return (SSO_OUTCOMES as readonly (string | undefined)[]).includes(value);
}

function errorCode(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

/**
 * Sign in: one card in the centred column, the admin's welcome text and notice above it. With
 * identity providers set up, their buttons come first (board Identity, frames 1A to 1D) and the
 * password form follows open, folded or not at all, as the server says.
 */
export function LoginPage() {
  const search = loginRoute.useSearch();
  return <SignInPage variant="main" search={search} />;
}

/**
 * The fixed, unlinked page `/anmelden/lokal`: always the password form, sent to the local
 * sign-in that lets the break-glass admin in while password sign-in is off.
 */
export function LocalLoginPage() {
  const search = localRoute.useSearch();
  return <SignInPage variant="local" search={search} />;
}

/** How the password form shows: alone (no providers), open, folded behind a button, or not. */
type FormMode = "plain" | "expanded" | "collapsed" | "hidden";

/**
 * Wrong credentials keep the email and select the password; after too many failures the button
 * counts down the wait the server names, and only its end is announced.
 */
function SignInPage({ variant, search }: { variant: "main" | "local"; search: LoginSearch }) {
  const { t } = useI18n();
  useDocumentTitle(variant === "local" ? "access.login.localTitle" : "access.login.title");
  const router = useRouter();
  const queryClient = useQueryClient();
  const branding = useBrandingSync();
  const welcome = branding?.signIn.welcome.trim() ?? "";
  const notice = branding?.signIn.notice.trim() ?? "";
  const providersQuery = useQuery({ ...signInProvidersQuery, enabled: variant === "main" });
  const listed = providersQuery.data?.providers ?? [];
  // LDAP directories sign people in through the password form, never with a button of their own
  // (board frame 1B); the first field then takes an email or a directory user name.
  const providers = listed.filter((provider) => provider.kind !== "ldap");
  const directory =
    variant === "main" ? listed.find((provider) => provider.kind === "ldap") : undefined;

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [notMine, setNotMine] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [firstWait, setFirstWait] = useState(0);
  const [opened, setOpened] = useState(() => readPreference(PASSWORD_OPEN_KEY) === "true");
  const [focusEmail, setFocusEmail] = useState(false);
  /** The provider whose sign-in the browser is on its way to. */
  const [leaving, setLeaving] = useState<SignInProvider | null>(null);
  const refs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  const left = useCountdown(until);
  const waiting = until !== null && left > 0;
  const waited = until !== null && left === 0;

  // The second step, when the account has a second factor or must set one up.
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [pendingEnded, setPendingEnded] = useState(false);
  // Back from a provider with the second step still to take: its prompt comes from the server.
  const afterProvider = search.secondFactor === true;
  useEffect(() => {
    if (!afterProvider) {
      return;
    }
    let current = true;
    fetchPrompt().then(
      (next) => {
        if (current) {
          setPendingEnded(false);
          setPrompt(next);
        }
      },
      () => {
        if (current) {
          setPendingEnded(true);
        }
      },
    );
    return () => {
      current = false;
    };
  }, [afterProvider]);

  async function signedIn(me: Me, to?: string) {
    // Whatever the previous session left (its preferences above all) is not this account's.
    forgetAccountData(queryClient);
    queryClient.setQueryData(meQuery.queryKey, me);
    await router.navigate({ href: to ?? search.redirect ?? "/", replace: true });
  }

  const signIn = useMutation({
    mutationFn: (input: LoginInput): Promise<Me | { secondFactor: unknown }> =>
      variant === "local" ? loginLocal(input) : login(input),
    // A sign-in is never repeated on its own: each attempt counts against the sign-in limit.
    retry: false,
    onSuccess: async (result) => {
      if ("secondFactor" in result) {
        if (isPrompt(result.secondFactor)) {
          setPendingEnded(false);
          setPrompt(result.secondFactor);
        }
        return;
      }
      await signedIn(result);
    },
    onError: (error) => {
      const wait = waitUntil(error);
      if (wait !== null) {
        setUntil(wait);
        setFirstWait(Math.ceil((wait - Date.now()) / 1000));
        return;
      }
      const rejected = fieldFromServer(FIELD_ORDER, error);
      if (rejected !== undefined) {
        setErrors({ [rejected]: { key: "validation.serverRejected" } });
        refs[rejected].current?.focus();
      } else if (errorCode(error) === "validation") {
        refs.email.current?.focus();
      }
      // Wrong credentials: keep the email, let the user retype the password right away.
      if (errorCode(error) === "invalid_credentials") {
        refs.password.current?.select();
        refs.password.current?.focus();
      }
    },
  });

  useEffect(() => {
    if (focusEmail) {
      refs.email.current?.focus();
      setFocusEmail(false);
    }
  });

  // The way back from a provider ends here with its outcome; shown once the page stands, so
  // screen readers announce it, and given up with the next attempt.
  const [ssoArrival, setSsoArrival] = useState<SsoOutcome | null>(null);
  useEffect(() => {
    setSsoArrival(variant === "main" ? (search.sso ?? null) : null);
  }, [variant, search.sso]);

  let mode: FormMode = "plain";
  if (variant === "main" && providers.length > 0 && providersQuery.data !== undefined) {
    const form = providersQuery.data.passwordForm;
    if (directory !== undefined) {
      // Directory accounts always sign in with the form, whatever applies to local passwords.
      mode = form === "hidden" ? "collapsed" : form;
    } else {
      mode = providersQuery.data.localSignIn ? form : "hidden";
    }
  }
  const passwordOff = errorReason(signIn.error)?.reason === PASSWORD_OFF;
  // An answer about the password (it is off for the account) keeps the form where it was typed.
  const formShown =
    mode === "plain" || mode === "expanded" || (mode === "collapsed" && (opened || !signIn.isIdle));
  // Until the server said which providers there are, the card waits instead of flashing a form
  // that then folds away.
  const ready = variant === "local" || providersQuery.data !== undefined || providersQuery.isError;

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signIn.isPending || waiting) {
      return;
    }
    const found = validateLogin({ email, password }, directory !== undefined);
    setErrors(found);
    const invalid = firstInvalid(FIELD_ORDER, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    setUntil(null);
    setSsoArrival(null);
    signIn.mutate({
      email: trimWhitespace(email),
      password,
      ...(notMine ? { forgetBrowser: true } : {}),
    });
  }

  function edit(field: LoginField, setValue: (value: string) => void) {
    return (value: string) => {
      setValue(value);
      if (errors[field] !== undefined) {
        const next = { ...errors };
        delete next[field];
        setErrors(next);
      }
    };
  }

  function openForm() {
    setOpened(true);
    setFocusEmail(true);
    writePreference(PASSWORD_OPEN_KEY, "true");
  }

  function startSso(event: MouseEvent<HTMLAnchorElement>, provider: SignInProvider) {
    // A new tab or window (Ctrl, Shift, middle click) goes its own way; this one stays.
    if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) {
      return;
    }
    event.preventDefault();
    if (leaving !== null) {
      return;
    }
    setLeaving(provider);
    setSsoArrival(null);
    leavePage.go(event.currentTarget.href);
  }

  const fieldError = (field: LoginField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };

  // The form's notice: wrong credentials, the wait after too many failures, or another error.
  let alert: ReactNode = null;
  const code = signIn.error === null ? null : errorCode(signIn.error);
  const reason = errorReason(signIn.error);
  const refusedOutcome = reason?.reason === DIRECTORY_REFUSED ? reason.params?.outcome : undefined;
  if (waiting) {
    alert = (
      <AccessNotice
        tone="danger"
        icon="clock"
        title={t("access.login.rateLimited")}
        detail={
          firstWait > 60
            ? t("access.waitMinutes", { count: Math.ceil(firstWait / 60) })
            : t("access.waitUnderMinute")
        }
      />
    );
  } else if (passwordOff) {
    const first = providers[0];
    alert = (
      <AccessNotice
        tone="danger"
        icon="lock"
        title={t("access.sso.passwordOff")}
        detail={
          first === undefined
            ? t("access.sso.passwordOffNoProvider")
            : t("access.sso.passwordOffDetail", { provider: first.name })
        }
      />
    );
  } else if (reason?.reason === DIRECTORY_UNREACHABLE) {
    alert = (
      <AccessNotice
        tone="danger"
        icon="alert"
        title={t("access.ldap.unreachable", { provider: directory?.name ?? "LDAP" })}
        detail={t("access.ldap.unreachableDetail")}
      />
    );
  } else if (reason?.reason === DIRECTORY_REFUSED) {
    alert = (
      <SsoOutcomeNotice
        t={t}
        outcome={isSsoOutcome(refusedOutcome) ? refusedOutcome : "failed"}
        provider={directory?.name ?? "LDAP"}
        reference={reason.params?.ref}
      />
    );
  } else if (code === "invalid_credentials") {
    alert = (
      <AccessNotice
        tone="danger"
        icon="alert"
        title={t("access.login.wrong")}
        detail={t("access.login.wrongDetail")}
      />
    );
  } else if (
    code !== null &&
    code !== "rate_limited" &&
    fieldFromServer(FIELD_ORDER, signIn.error) === undefined
  ) {
    alert = <AccessNotice tone="danger" icon="alert" title={t(`errors.${code}`)} />;
  } else if (signIn.isIdle && ssoArrival !== null) {
    alert = (
      <SsoOutcomeNotice
        t={t}
        outcome={ssoArrival}
        provider={providerName(providers, search.provider)}
        reference={search.ref}
      />
    );
  }

  // Status notices are mounted empty and filled after the first render, so screen readers
  // announce them; they give way to whatever the next attempt brings.
  const [arrival, setArrival] = useState<"signedOut" | "expired" | null>(null);
  useEffect(() => {
    setArrival(
      search.signedOut === true ? "signedOut" : search.expired === true ? "expired" : null,
    );
  }, [search.signedOut, search.expired]);
  let status = null;
  if (waited && !signIn.isPending) {
    status = <AccessNotice tone="info" icon="check" title={t("access.login.ready")} />;
  } else if (signIn.isIdle && arrival === "signedOut") {
    status = <AccessNotice tone="info" icon="check" title={t("access.login.signedOut")} />;
  } else if (signIn.isIdle && arrival === "expired") {
    status = (
      <AccessNotice
        tone="info"
        icon="clock"
        title={t("access.login.expired")}
        detail={t("access.login.expiredDetail")}
      />
    );
  }

  if (prompt !== null) {
    const back = () => {
      setPrompt(null);
      setPassword("");
      signIn.reset();
    };
    const props = {
      prompt,
      onSignedIn: (me: Me, to?: string) => void signedIn(me, to),
      onSignOut: () => {
        void logout().finally(back);
      },
      onExpired: () => {
        back();
        setPendingEnded(true);
      },
    };
    return (
      <AccessLayout>
        {prompt.linkPassword === true ? (
          <LinkPasswordStep {...props} onPrompt={setPrompt} />
        ) : prompt.setup ? (
          <SecondFactorSetup {...props} />
        ) : (
          <SecondFactorStep {...props} />
        )}
      </AccessLayout>
    );
  }

  if (pendingEnded && signIn.isIdle && status === null) {
    status = <AccessNotice tone="info" icon="clock" title={t("security.signIn.expired")} />;
  }

  const busy = signIn.isPending;
  let submit = t("access.login.submit");
  if (busy) {
    submit = t("access.login.submitting");
  } else if (waiting) {
    submit = t("access.retryIn", { time: formatWait(left) });
  }
  // Copper is on one button only: the first provider's, unless the form stands open below.
  const submitIsMain = mode === "plain" || mode === "expanded";
  const returnTo = search.redirect ?? "/";

  return (
    <AccessLayout>
      <div className="access__head">
        <h1>{t(variant === "local" ? "access.login.localTitle" : "access.login.title")}</h1>
        {variant === "local" ? (
          <p className="access__lead">{t("access.login.localLead")}</p>
        ) : welcome === "" ? (
          <p className="access__lead">{t("access.login.lead")}</p>
        ) : (
          <LimitedMarkdown text={welcome} className="access__lead limited-markdown" />
        )}
      </div>
      {notice === "" ? null : (
        <div className="access-notice access-notice--info" role="note">
          <Icon name="alert" />
          <LimitedMarkdown text={notice} className="limited-markdown" />
        </div>
      )}
      <form
        className="access__card"
        noValidate
        aria-label={t(variant === "local" ? "access.login.localTitle" : "access.login.title")}
        aria-busy={ready ? undefined : true}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        <div className="access__status" role="status">
          {status}
        </div>
        <AccessAlert>{alert}</AccessAlert>
        {mode === "plain" ? null : (
          <div className="access__sso">
            {providers.map((provider, index) => {
              const going = leaving?.slug === provider.slug;
              const main = index === 0 && !submitIsMain;
              return (
                <a
                  key={provider.slug}
                  href={ssoStartUrl(provider.slug, returnTo)}
                  className={
                    main
                      ? "button button--primary button--block"
                      : "button button--secondary button--block"
                  }
                  aria-disabled={leaving === null ? undefined : true}
                  onClick={(event) => startSso(event, provider)}
                >
                  {going ? <span className="access__spinner" aria-hidden="true" /> : null}
                  {going
                    ? t("access.sso.leaving", { provider: provider.name })
                    : t("access.sso.button", { provider: provider.name })}
                </a>
              );
            })}
          </div>
        )}
        {mode === "expanded" || (mode === "collapsed" && formShown) ? (
          <p className="access__or">{t("access.sso.orPassword")}</p>
        ) : mode === "collapsed" ? (
          <>
            <p className="access__or">{t("access.sso.or")}</p>
            <button
              type="button"
              className="button button--secondary button--block access__submit"
              aria-expanded={false}
              onClick={openForm}
            >
              {t("access.sso.withPassword")}
            </button>
          </>
        ) : null}
        {ready && formShown ? (
          <>
            <TextField
              ref={refs.email}
              label={t(directory === undefined ? "access.login.email" : "access.ldap.login")}
              type={directory === undefined ? "email" : "text"}
              name="email"
              autoComplete="username"
              inputMode={directory === undefined ? "email" : "text"}
              autoCapitalize="none"
              spellCheck={false}
              placeholder={directory === undefined ? t("access.login.emailPlaceholder") : undefined}
              hint={
                directory === undefined
                  ? undefined
                  : t("access.ldap.loginHint", { provider: directory.name })
              }
              required
              readOnly={busy}
              value={email}
              onValueChange={edit("email", setEmail)}
              error={fieldError("email")}
            />
            <PasswordField
              ref={refs.password}
              label={t("access.login.password")}
              name="password"
              autoComplete="current-password"
              readOnly={busy}
              value={password}
              onValueChange={edit("password", setPassword)}
              error={fieldError("password")}
              aside={
                // A link by mail, or, without mail on the server, who can help (ResetPasswordPage).
                <Link to="/reset-password" className="access__quiet-link">
                  {t("access.login.forgot")}
                </Link>
              }
            />
            {/* A shared or borrowed browser: it does not become a known device of the account. */}
            <label className="access__check">
              <input
                type="checkbox"
                name="forgetBrowser"
                checked={notMine}
                disabled={busy}
                onChange={(event) => setNotMine(event.currentTarget.checked)}
              />
              <span>{t("access.login.notMyBrowser")}</span>
              <span className="access__check-note">{t("access.login.notMyBrowserNote")}</span>
            </label>
            <button
              type="submit"
              className={
                waiting
                  ? "button button--block access__submit access__submit--waiting"
                  : submitIsMain
                    ? "button button--primary button--block access__submit"
                    : "button button--secondary button--block access__submit"
              }
              aria-disabled={busy || waiting}
            >
              {busy ? <span className="access__spinner" aria-hidden="true" /> : null}
              {waiting ? <span className="access__wait">{submit}</span> : submit}
            </button>
          </>
        ) : null}
      </form>
      <p className="access__below">{t("access.login.noAccount")}</p>
    </AccessLayout>
  );
}

/** The provider's name for the notices, its slug when the page does not know it (any more). */
function providerName(providers: readonly SignInProvider[], slug: string | undefined): string {
  if (slug === undefined) {
    return "SSO";
  }
  return providers.find((provider) => provider.slug === slug)?.name ?? slug;
}

/**
 * Why a sign-in through a provider did not end in a session (board frame 1C). The texts never
 * name details of the configuration; the error id leads admins to the audit entry with the cause.
 */
function SsoOutcomeNotice({
  t,
  outcome,
  provider,
  reference,
}: {
  t: Translate;
  outcome: SsoOutcome;
  provider: string;
  reference: string | undefined;
}) {
  return (
    <AccessNotice
      tone="danger"
      icon={outcome === "disabled" || outcome === "unmapped" ? "lock" : "alert"}
      title={t(`access.sso.outcome.${outcome}.title`, { provider })}
      detail={
        reference === undefined
          ? t(`access.sso.outcome.${outcome}.detail`, { provider })
          : `${t(`access.sso.outcome.${outcome}.detail`, { provider })} ${t("access.sso.ref", { ref: reference })}`
      }
    />
  );
}
