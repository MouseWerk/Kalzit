import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { isApiError } from "../api/client";
import { TextField } from "../components/TextField";
import { errorReason, reasonText } from "../features/datasources/reasons";
import { type Translate, useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice, LinkState } from "./AccessLayout";
import { forgetToken } from "./linksApi";
import { PasswordField } from "./PasswordField";
import {
  confirmRegistration,
  getRegistration,
  type RegistrationAvailability,
  registrationKey,
  startRegistration,
} from "./registrationApi";
import { useLinkToken } from "./useLinkToken";
import {
  type FieldErrors,
  fieldFromServer,
  firstInvalid,
  preventComposingSubmit,
  trimWhitespace,
  validateNewAccount,
  validateResetEmail,
} from "./validation";
import "./auth.css";
import "./links.css";

/** Seconds until "Send the link again" is offered again. */
const RESEND_WAIT = 60;

/** Why the server refused, in the page's words; the server's own text when the page has none. */
function refusal(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  return (
    (reason === undefined ? undefined : reasonText(t, reason)) ??
    t(`errors.${isApiError(error) ? error.code : "internal"}`)
  );
}

const toSignIn = (t: Translate) => (
  <Link to="/login" className="button button--primary">
    {t("access.toLogin")}
  </Link>
);

/**
 * Self-registration for visitors (board Settings075.dc.html, frame 4), on the calm backdrop of
 * the sign-in pages: ask for a link with an address of an allowed domain, check the inbox, then
 * choose name and password behind the link. With admin approval the account waits for a decision.
 * The page never says whether an address already has an account.
 */
export function RegisterPage() {
  const { t } = useI18n();
  useDocumentTitle("access.signup.title");
  const token = useLinkToken("register", "/register");
  const offered = useQuery({ queryKey: registrationKey, queryFn: getRegistration });
  // After a link that no longer works, the page starts over with a new one.
  const [startOver, setStartOver] = useState(false);
  let body = <p className="access__lead">{t("common.loading")}</p>;
  if (token !== "" && !startOver) {
    body = <Confirm token={token} onStartOver={() => setStartOver(true)} />;
  } else if (offered.data !== undefined) {
    body = offered.data.available ? (
      <Start offered={offered.data} />
    ) : (
      <LinkState
        tone="info"
        icon="link"
        title={t("access.signup.closedTitle")}
        text={t("access.signup.closedText")}
        action={toSignIn(t)}
      />
    );
  } else if (offered.isError) {
    body = (
      <LinkState
        tone="danger"
        icon="link"
        title={refusal(t, offered.error)}
        text=""
        action={toSignIn(t)}
      />
    );
  }
  return <AccessLayout>{body}</AccessLayout>;
}

function Start({ offered }: { offered: RegistrationAvailability }) {
  const { t, language } = useI18n();
  const [email, setEmail] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"email">>({});
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [wait, setWait] = useState(0);
  const ref = useRef<HTMLInputElement>(null);
  const start = useMutation({
    mutationFn: (address: string) => startRegistration(address, language),
    retry: false,
    onSuccess: (_, address) => {
      setSentTo(address);
      setWait(RESEND_WAIT);
    },
    onError: () => ref.current?.focus(),
  });
  useEffect(() => {
    if (wait <= 0) return;
    const timer = window.setTimeout(() => setWait((left) => left - 1), 1000);
    return () => window.clearTimeout(timer);
  }, [wait]);
  // A domain that may not register is said at the field; everything else above the form.
  const atField =
    start.error !== null &&
    (errorReason(start.error)?.reason === "signup.domain_not_allowed" ||
      fieldFromServer(["email"], start.error) !== undefined);
  const failed = start.error === null || atField ? null : refusal(t, start.error);

  if (sentTo !== null) {
    return (
      <div className="access__card link-state" role="status">
        <AccessNotice
          tone="info"
          icon="check"
          title={t("access.signup.sentTitle")}
          detail={t("access.signup.sentText", { email: sentTo })}
          heading
        />
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={wait > 0 || start.isPending}
          onClick={() => {
            if (wait <= 0 && !start.isPending) start.mutate(sentTo);
          }}
        >
          {wait > 0 ? t("access.signup.resendIn", { seconds: wait }) : t("access.signup.resend")}
        </button>
      </div>
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (start.isPending) return;
    const found = validateResetEmail(email);
    setErrors(found);
    if (found.email !== undefined) {
      ref.current?.focus();
      return;
    }
    start.mutate(trimWhitespace(email));
  }
  return (
    <form
      className="access__card"
      noValidate
      aria-label={t("access.signup.title")}
      onSubmit={onSubmit}
      onKeyDown={preventComposingSubmit}
    >
      <div className="access__head">
        <h1>{t("access.signup.title")}</h1>
        <p className="access__lead">
          {t("access.signup.lead", { domains: offered.allowedDomains.join(", ") })}
        </p>
      </div>
      <AccessAlert>
        {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
      </AccessAlert>
      <TextField
        ref={ref}
        label={t("access.login.email")}
        type="email"
        name="email"
        autoComplete="email"
        required
        readOnly={start.isPending}
        value={email}
        onValueChange={(value) => {
          setEmail(value);
          setErrors({});
          start.reset();
        }}
        error={
          errors.email !== undefined
            ? t(errors.email.key, errors.email.params)
            : atField
              ? refusal(t, start.error)
              : undefined
        }
      />
      <button
        type="submit"
        className="button button--primary button--block access__submit"
        aria-disabled={start.isPending}
      >
        {start.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
        {t("access.signup.title")}
      </button>
      <p className="access__below">
        <Link to="/login" className="access__quiet-link">
          {t("access.signup.haveAccount")}
        </Link>
      </p>
    </form>
  );
}

const FIELD_ORDER = ["name", "password"] as const;

function Confirm({ token, onStartOver }: { token: string; onStartOver: () => void }) {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<FieldErrors<"name" | "password">>({});
  const refs = { name: useRef<HTMLInputElement>(null), password: useRef<HTMLInputElement>(null) };
  const confirm = useMutation({
    mutationFn: () => confirmRegistration(token, trimWhitespace(name), password),
    retry: false,
    onError: (error) => {
      const field = fieldFromServer(FIELD_ORDER, error);
      if (field !== undefined) {
        setErrors({ [field]: { key: "validation.serverRejected" } });
        refs[field].current?.focus();
      }
    },
  });
  const invalid = isApiError(confirm.error, "not_found");
  const done = confirm.isSuccess;
  useEffect(() => {
    if (done || invalid) forgetToken("register");
  }, [done, invalid]);

  if (invalid) {
    return (
      <LinkState
        tone="danger"
        icon="link"
        title={t("access.confirm.invalidTitle")}
        text={t("access.signup.linkGone")}
        action={
          <button type="button" className="button button--primary" onClick={onStartOver}>
            {t("access.signup.title")}
          </button>
        }
      />
    );
  }
  if (done) {
    return (
      <LinkState
        tone="info"
        icon={confirm.data === "approved" ? "check" : "clock"}
        title={t(
          confirm.data === "approved" ? "access.signup.doneTitle" : "access.signup.waitTitle",
        )}
        text={t(confirm.data === "approved" ? "access.signup.doneText" : "access.signup.waitText")}
        action={toSignIn(t)}
        status
      />
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (confirm.isPending) return;
    const found = validateNewAccount({ name, password });
    setErrors(found);
    const first = firstInvalid(FIELD_ORDER, found);
    if (first !== undefined) {
      refs[first].current?.focus();
      return;
    }
    confirm.mutate();
  }
  const fieldError = (field: "name" | "password") => {
    const error = errors[field];
    return error === undefined ? undefined : t(error.key, error.params);
  };
  const failed =
    confirm.error === null || fieldFromServer(FIELD_ORDER, confirm.error) !== undefined
      ? null
      : refusal(t, confirm.error);
  return (
    <form
      className="access__card"
      noValidate
      aria-label={t("access.signup.title")}
      onSubmit={onSubmit}
      onKeyDown={preventComposingSubmit}
    >
      <div className="access__head">
        <h1>{t("access.signup.title")}</h1>
        <p className="access__lead">{t("access.signup.confirmLead")}</p>
      </div>
      <AccessAlert>
        {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
      </AccessAlert>
      <TextField
        ref={refs.name}
        label={t("access.invite.name")}
        name="name"
        autoComplete="name"
        required
        readOnly={confirm.isPending}
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
        readOnly={confirm.isPending}
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
        aria-disabled={confirm.isPending}
      >
        {confirm.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
        {t("access.signup.title")}
      </button>
    </form>
  );
}
