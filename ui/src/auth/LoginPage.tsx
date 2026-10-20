import { useMutation, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, useRouter } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { login, meQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { FormAlert } from "../components/FormAlert";
import { TextField } from "../components/TextField";
import { type MessageKey, useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AuthLayout } from "./AuthLayout";
import {
  type FieldErrors,
  firstInvalid,
  type LoginField,
  preventComposingSubmit,
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
    onSuccess: async (me) => {
      queryClient.setQueryData(meQuery.queryKey, me);
      await router.navigate({ href: search.redirect ?? "/", replace: true });
    },
    onError: (error) => {
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
    signIn.mutate({ email: email.trim(), password });
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
    const key = errors[field];
    return key === undefined ? undefined : t(key);
  };
  const serverError: MessageKey | null =
    signIn.error === null ? null : `errors.${errorCode(signIn.error)}`;

  return (
    <AuthLayout title={t("login.title")} lead={t("login.lead")}>
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
        <TextField
          ref={refs.password}
          label={t("login.password")}
          type="password"
          name="password"
          autoComplete="current-password"
          required
          value={password}
          onValueChange={edit("password", setPassword)}
          error={fieldError("password")}
        />
        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary button--block"
            aria-disabled={signIn.isPending}
          >
            {signIn.isPending ? t("login.submitting") : t("login.submit")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
