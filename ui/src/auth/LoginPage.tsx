import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { forgetAccountData, login, meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { useBrandingSync } from "../appearance/api";
import { LimitedMarkdown } from "../appearance/LimitedMarkdown";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
import { formatWait, useCountdown, waitUntil } from "./countdown";
import { PasswordField } from "./PasswordField";
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

function errorCode(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

/**
 * Sign in: one card in the centred column, the admin's welcome text and notice above it. Wrong
 * credentials keep the email and select the password; after too many failures the button counts
 * down the wait the server names, and only its end is announced.
 */
export function LoginPage() {
  const { t } = useI18n();
  useDocumentTitle("access.login.title");
  const search = loginRoute.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();
  const branding = useBrandingSync();
  const welcome = branding?.signIn.welcome.trim() ?? "";
  const notice = branding?.signIn.notice.trim() ?? "";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const [forgotOpen, setForgotOpen] = useState(false);
  const [until, setUntil] = useState<number | null>(null);
  const [firstWait, setFirstWait] = useState(0);
  const forgotId = useId();
  const refs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  const left = useCountdown(until);
  const waiting = until !== null && left > 0;
  const waited = until !== null && left === 0;

  const signIn = useMutation({
    mutationFn: login,
    // A sign-in is never repeated on its own: each attempt counts against the sign-in limit.
    retry: false,
    onSuccess: async (me) => {
      // Whatever the previous session left (its preferences above all) is not this account's.
      forgetAccountData(queryClient);
      queryClient.setQueryData(meQuery.queryKey, me);
      await router.navigate({ href: search.redirect ?? "/", replace: true });
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

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (signIn.isPending || waiting) {
      return;
    }
    const found = validateLogin({ email, password });
    setErrors(found);
    const invalid = firstInvalid(FIELD_ORDER, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    setUntil(null);
    signIn.mutate({ email: trimWhitespace(email), password });
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

  const fieldError = (field: LoginField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };

  // The form's notice: wrong credentials, the wait after too many failures, or another error.
  let alert = null;
  const code = signIn.error === null ? null : errorCode(signIn.error);
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

  const busy = signIn.isPending;
  let submit = t("access.login.submit");
  if (busy) {
    submit = t("access.login.submitting");
  } else if (waiting) {
    submit = t("access.retryIn", { time: formatWait(left) });
  }

  return (
    <AccessLayout>
      <div className="access__head">
        <h1>{t("access.login.title")}</h1>
        {welcome === "" ? (
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
        aria-label={t("access.login.title")}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        <div className="access__status" role="status">
          {status}
        </div>
        <AccessAlert>{alert}</AccessAlert>
        <TextField
          ref={refs.email}
          label={t("access.login.email")}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          placeholder={t("access.login.emailPlaceholder")}
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
            <button
              type="button"
              className="access__quiet-link"
              aria-expanded={forgotOpen}
              aria-controls={forgotId}
              onClick={() => setForgotOpen(!forgotOpen)}
            >
              {t("access.login.forgot")}
            </button>
          }
        />
        <div id={forgotId} className="access__forgot" aria-live="polite">
          {forgotOpen ? <p className="field__hint">{t("access.login.forgotHint")}</p> : null}
        </div>
        <button
          type="submit"
          className={
            waiting
              ? "button button--block access__submit access__submit--waiting"
              : "button button--primary button--block access__submit"
          }
          aria-disabled={busy || waiting}
        >
          {busy ? <span className="access__spinner" aria-hidden="true" /> : null}
          {waiting ? <span className="access__wait">{submit}</span> : submit}
        </button>
      </form>
      <p className="access__below">{t("access.login.noAccount")}</p>
    </AccessLayout>
  );
}
