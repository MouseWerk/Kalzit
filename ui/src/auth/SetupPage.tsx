import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouter } from "@tanstack/react-router";
import { type FormEvent, useRef, useState } from "react";
import { completeSetup, meQuery, setupStatusQuery } from "../api/auth";
import { type ErrorCode, isApiError } from "../api/client";
import { FormAlert } from "../components/FormAlert";
import { TextField } from "../components/TextField";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AuthLayout } from "./AuthLayout";
import { PasswordField } from "./PasswordField";
import "./auth.css";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  MIN_PASSWORD_LENGTH,
  preventComposingSubmit,
  type SetupField,
  type SetupValues,
  trimWhitespace,
  validateSetup,
} from "./validation";

const FIELD_ORDER: readonly SetupField[] = ["token", "orgName", "name", "email", "password"];

const EMPTY: SetupValues = { token: "", orgName: "", name: "", email: "", password: "" };

function errorCode(error: unknown): ErrorCode {
  return isApiError(error) ? error.code : "internal";
}

export function SetupPage() {
  const { t } = useI18n();
  useDocumentTitle("setup.title");
  const router = useRouter();
  const queryClient = useQueryClient();

  const [values, setValues] = useState<SetupValues>(EMPTY);
  const [errors, setErrors] = useState<FieldErrors<SetupField>>({});
  const refs = {
    token: useRef<HTMLInputElement>(null),
    orgName: useRef<HTMLInputElement>(null),
    name: useRef<HTMLInputElement>(null),
    email: useRef<HTMLInputElement>(null),
    password: useRef<HTMLInputElement>(null),
  };

  const setup = useMutation({
    mutationFn: completeSetup,
    onSuccess: async (me) => {
      queryClient.setQueryData(setupStatusQuery.queryKey, { needed: false });
      queryClient.setQueryData(meQuery.queryKey, me);
      await router.navigate({ to: "/", replace: true });
    },
    onError: (error) => {
      const code = errorCode(error);
      const rejected = fieldFromServer(FIELD_ORDER, error);
      if (code === "invalid_setup_token") {
        // A wrong code belongs to its field, so it is shown and announced there.
        setErrors({ token: { key: "errors.invalid_setup_token" } });
        refs.token.current?.focus();
      } else if (rejected !== undefined) {
        setErrors({ [rejected]: { key: "validation.serverRejected" } });
        refs[rejected].current?.focus();
      } else if (code === "validation") {
        refs.token.current?.focus();
      } else if (code === "setup_done") {
        queryClient.setQueryData(setupStatusQuery.queryKey, { needed: false });
      }
    },
  });

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (setup.isPending) {
      return;
    }
    const found = validateSetup(values);
    setErrors(found);
    const invalid = firstInvalid(FIELD_ORDER, found);
    if (invalid !== undefined) {
      refs[invalid].current?.focus();
      return;
    }
    setup.mutate({
      token: trimWhitespace(values.token),
      orgName: trimWhitespace(values.orgName),
      name: trimWhitespace(values.name),
      email: trimWhitespace(values.email),
      password: values.password,
    });
  }

  function edit(field: SetupField) {
    return (value: string) => {
      setValues({ ...values, [field]: value });
      if (errors[field] !== undefined) {
        const next = { ...errors };
        delete next[field];
        setErrors(next);
      }
    };
  }

  const fieldError = (field: SetupField) => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };

  const code = setup.error === null ? null : errorCode(setup.error);
  let formError: string | null = null;
  if (code === "setup_done") {
    formError = t("errors.setup_done");
  } else if (
    code !== null &&
    code !== "invalid_setup_token" &&
    fieldFromServer(FIELD_ORDER, setup.error) === undefined
  ) {
    formError = t(`errors.${code}`);
  }

  return (
    <AuthLayout title={t("setup.title")} lead={t("setup.lead")} wide>
      <FormAlert>
        {formError === null ? null : (
          <>
            {formError}
            {code === "setup_done" ? (
              <>
                {" "}
                <Link to="/login">{t("setup.goToLogin")}</Link>
              </>
            ) : null}
          </>
        )}
      </FormAlert>
      <form className="form" noValidate onSubmit={onSubmit} onKeyDown={preventComposingSubmit}>
        <fieldset className="auth__group">
          <legend className="auth__legend">
            <span className="auth__step" aria-hidden="true">
              1
            </span>
            {t("setup.groupServer")}
          </legend>
          <TextField
            ref={refs.token}
            label={t("setup.token")}
            hint={t("setup.tokenHint")}
            name="setup-token"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            mono
            required
            value={values.token}
            onValueChange={edit("token")}
            error={fieldError("token")}
          />
        </fieldset>
        <fieldset className="auth__group">
          <legend className="auth__legend">
            <span className="auth__step" aria-hidden="true">
              2
            </span>
            {t("setup.groupOrg")}
          </legend>
          <TextField
            ref={refs.orgName}
            label={t("setup.orgName")}
            hint={t("setup.orgNameHint")}
            name="organization"
            autoComplete="organization"
            required
            value={values.orgName}
            onValueChange={edit("orgName")}
            error={fieldError("orgName")}
          />
        </fieldset>
        <fieldset className="auth__group">
          <legend className="auth__legend">
            <span className="auth__step" aria-hidden="true">
              3
            </span>
            {t("setup.groupAccount")}
          </legend>
          <TextField
            ref={refs.name}
            label={t("setup.name")}
            name="name"
            autoComplete="name"
            required
            value={values.name}
            onValueChange={edit("name")}
            error={fieldError("name")}
          />
          <TextField
            ref={refs.email}
            label={t("setup.email")}
            type="email"
            name="email"
            autoComplete="username"
            inputMode="email"
            autoCapitalize="none"
            spellCheck={false}
            required
            value={values.email}
            onValueChange={edit("email")}
            error={fieldError("email")}
          />
          <PasswordField
            ref={refs.password}
            label={t("setup.password")}
            hint={t("setup.passwordHint", { count: MIN_PASSWORD_LENGTH })}
            name="new-password"
            autoComplete="new-password"
            showStrength
            value={values.password}
            onValueChange={edit("password")}
            error={fieldError("password")}
          />
        </fieldset>
        <div className="form__actions">
          <button
            type="submit"
            className="button button--primary button--block auth__submit"
            aria-disabled={setup.isPending}
          >
            {setup.isPending ? <span className="auth__spinner" aria-hidden="true" /> : null}
            {setup.isPending ? t("setup.submitting") : t("setup.submit")}
          </button>
        </div>
      </form>
    </AuthLayout>
  );
}
