import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { forgetAccountData, login, meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { FormAlert } from "../components/FormAlert";
import { Icon } from "../components/Icon";
import { TextField } from "../components/TextField";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AuthLayout } from "./AuthLayout";
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

export function LoginPage() {
  const { t } = useI18n();
  useDocumentTitle("login.title");
  const search = loginRoute.useSearch();
  const router = useRouter();
  const queryClient = useQueryClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<LoginField>>({});
  const refs = {
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

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
    if (signIn.isPending) {
      return;
    }
    const found = validateLogin({ email, password });
    setErrors(found);
    const invalid = firstInvalid(FIELD_ORDER, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
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
  let serverError: MessageKey | null = null;
  if (signIn.error !== null && fieldFromServer(FIELD_ORDER, signIn.error) === undefined) {
    const code = errorCode(signIn.error);
    // The sign-in limit counts failures over minutes, so "a moment" would undersell the wait.
    serverError = code === "rate_limited" ? "login.rateLimited" : `errors.${code}`;
  }
  // The status region is mounted empty and filled after the first render, so screen readers
  // announce the confirmation; it gives way to whatever the next attempt brings.
  const [announced, setAnnounced] = useState(false);
  useEffect(() => {
    setAnnounced(search.signedOut === true);
  }, [search.signedOut]);
  const signedOut = announced && signIn.isIdle;

  return (
    <AuthLayout title={t("login.title")} lead={t("login.lead")} signInTexts>
      <div className="auth__status" role="status">
        {signedOut ? (
          <p className="notice auth__notice">
            <Icon name="check" />
            <span>{t("login.signedOut")}</span>
          </p>
        ) : null}
      </div>
      <FormAlert>{serverError === null ? null : t(serverError)}</FormAlert>
      <form className="form" noValidate onSubmit={onSubmit} onKeyDown={preventComposingSubmit}>
        <TextField
          ref={refs.email}
          label={t("login.email")}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          value={email}
          onValueChange={edit("email", setEmail)}
          error={fieldError("email")}
        />
        <PasswordField
          ref={refs.password}
          label={t("login.password")}
          name="password"
          autoComplete="current-password"
          value={password}
          onValueChange={edit("password", setPassword)}
          error={fieldError("password")}
        />
        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary button--block auth__submit"
            aria-disabled={signIn.isPending}
          >
            {signIn.isPending ? <span className="auth__spinner" aria-hidden="true" /> : null}
            {signIn.isPending ? t("login.submitting") : t("login.submit")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
