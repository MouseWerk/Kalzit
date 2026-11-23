import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { isApiError } from "../api/client";
import { TextField } from "../components/TextField";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessEnd, AccessLayout, AccessNotice } from "./AccessLayout";
import { formatWait, useCountdown, waitUntil } from "./countdown";
import {
  completePasswordReset,
  fetchResetAvailability,
  forgetToken,
  inspectPasswordLink,
  requestPasswordLink,
} from "./linksApi";
import { PasswordField } from "./PasswordField";
import { useLinkToken } from "./useLinkToken";
import "./auth.css";
import {
  fieldFromServer,
  preventComposingSubmit,
  trimWhitespace,
  validateNewPassword,
  validateResetEmail,
} from "./validation";

/** How long the page waits before it offers another link (the board's "new try in 0:52"). */
export const RESEND_WAIT_MS = 60_000;

/**
 * Password reset (board Auth.dc.html, frame 11): without a link, ask for one by email address,
 * answered the same whether or not an account has it, and saying so; with a link, set the new
 * password. A server without mail says that an admin can help instead of offering a form that
 * sends nothing. Sent, saved and gone links are pages of their own.
 */
export function ResetPasswordPage() {
  useDocumentTitle("access.reset.pageTitle");
  const token = useLinkToken("reset", "/reset-password");
  // A link that no longer works offers a new one right here.
  const [requesting, setRequesting] = useState(token === "");
  return (
    <AccessLayout>
      {requesting ? (
        <RequestLink />
      ) : (
        <NewPassword token={token} onRequestNew={() => setRequesting(true)} />
      )}
    </AccessLayout>
  );
}

function BackToSignIn() {
  const { t } = useI18n();
  return (
    <p className="access__below">
      <Link to="/login" className="access__link">
        {t("access.reset.back")}
      </Link>
    </p>
  );
}

function RequestLink() {
  const { t } = useI18n();
  const available = useQuery({
    queryKey: ["password-reset", "available"],
    queryFn: fetchResetAvailability,
    retry: false,
  });
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const left = useCountdown(until);
  const send = useMutation({
    mutationFn: (address: string) => requestPasswordLink(address),
    retry: false,
    onSuccess: (_, address) => {
      setSentTo(address);
      setUntil(Date.now() + RESEND_WAIT_MS);
    },
    onError: (failure) => {
      const wait = waitUntil(failure);
      if (wait !== null) {
        setUntil(wait);
      }
    },
  });

  if (available.data === false || isApiError(send.error, "conflict")) {
    return (
      <AccessEnd
        icon="members"
        title={t("access.reset.noMailTitle")}
        text={t("access.reset.noMailText")}
        action={
          <Link to="/login" className="button button--secondary button--block">
            {t("access.reset.back")}
          </Link>
        }
      />
    );
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (send.isPending || (until !== null && left > 0)) {
      return;
    }
    const found = validateResetEmail(email).email;
    if (found !== undefined) {
      setError(t(found.key, found.params));
      emailRef.current?.focus();
      return;
    }
    send.mutate(trimWhitespace(email));
  }

  const waiting = until !== null && left > 0;
  if (sentTo !== null) {
    // Neutral: it never says whether the address has an account, and says that openly. The wait
    // runs on the button and is not announced every second.
    return (
      <AccessEnd
        icon="check"
        title={t("access.reset.sentTitle")}
        text={t("access.reset.sentText", { email: sentTo })}
        status
        action={
          <>
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={waiting}
              onClick={() => {
                if (waiting) return;
                send.reset();
                setSentTo(null);
              }}
            >
              <span aria-live="off" className={waiting ? "access__wait" : undefined}>
                {waiting
                  ? t("access.reset.againIn", { time: formatWait(left) })
                  : t("access.reset.again")}
              </span>
            </button>
            <Link to="/login" className="button button--secondary">
              {t("access.reset.back")}
            </Link>
          </>
        }
      />
    );
  }

  const failed =
    send.error === null
      ? null
      : waiting
        ? t("access.reset.rateLimited")
        : t(`errors.${isApiError(send.error) ? send.error.code : "internal"}`);
  return (
    <>
      <div className="access__head">
        <h1>{t("access.reset.title")}</h1>
        <p className="access__lead">{t("access.reset.lead")}</p>
      </div>
      <form
        className="access__form"
        noValidate
        aria-label={t("access.reset.title")}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        <TextField
          ref={emailRef}
          label={t("access.reset.email")}
          type="email"
          name="email"
          autoComplete="username"
          inputMode="email"
          autoCapitalize="none"
          spellCheck={false}
          required
          readOnly={send.isPending}
          value={email}
          onValueChange={(value) => {
            setEmail(value);
            setError(undefined);
          }}
          error={error}
        />
        <button
          type="submit"
          className={
            waiting
              ? "button button--block access__submit access__submit--waiting"
              : "button button--primary button--block access__submit"
          }
          aria-disabled={send.isPending || waiting}
        >
          {send.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
          {send.isPending ? (
            t("access.reset.sending")
          ) : waiting ? (
            <span className="access__wait">{t("access.retryIn", { time: formatWait(left) })}</span>
          ) : (
            t("access.reset.send")
          )}
        </button>
      </form>
      <BackToSignIn />
    </>
  );
}

function NewPassword({ token, onRequestNew }: { token: string; onRequestNew: () => void }) {
  const { t } = useI18n();
  const link = useQuery({
    queryKey: ["password-reset", token],
    queryFn: () => inspectPasswordLink(token),
    retry: false,
  });
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const passwordRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => completePasswordReset(token, password),
    retry: false,
    onSuccess: () => forgetToken("reset"),
    onError: (failure) => {
      if (fieldFromServer(["password"], failure) !== undefined) {
        setError(t("validation.serverRejected"));
        passwordRef.current?.focus();
      }
    },
  });

  const invalid =
    (link.error !== null && isApiError(link.error, "not_found")) ||
    (save.error !== null && isApiError(save.error, "not_found"));
  useEffect(() => {
    if (invalid) forgetToken("reset");
  }, [invalid]);

  if (invalid) {
    return (
      <AccessEnd
        icon="link"
        title={t("access.reset.invalidTitle")}
        text={t("access.reset.invalidText")}
        action={
          <button
            type="button"
            className="button button--primary button--block"
            onClick={onRequestNew}
          >
            {t("access.reset.newLink")}
          </button>
        }
      />
    );
  }
  if (save.isSuccess) {
    return (
      <AccessEnd
        icon="check"
        title={t("access.reset.doneTitle")}
        text={t("access.reset.doneText")}
        status
        action={
          <Link to="/login" className="button button--primary button--block">
            {t("access.toLogin")}
          </Link>
        }
      />
    );
  }
  if (link.error !== null) {
    return (
      <>
        <div className="access__head">
          <h1>{t("access.reset.newTitle")}</h1>
        </div>
        <AccessNotice
          tone="danger"
          icon="alert"
          title={
            isApiError(link.error, "rate_limited")
              ? t("access.links.rateLimited")
              : t(`errors.${isApiError(link.error) ? link.error.code : "internal"}`)
          }
        />
        <BackToSignIn />
      </>
    );
  }
  if (link.data === undefined) {
    return <p className="access__lead">{t("access.reset.checking")}</p>;
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (save.isPending) {
      return;
    }
    const found = validateNewPassword(password).password;
    if (found !== undefined) {
      setError(t(found.key, found.params));
      passwordRef.current?.focus();
      return;
    }
    save.mutate();
  }

  const failed =
    save.error === null || fieldFromServer(["password"], save.error) !== undefined
      ? null
      : t(`errors.${isApiError(save.error) ? save.error.code : "internal"}`);
  return (
    <>
      <div className="access__head">
        <h1>{t("access.reset.newTitle")}</h1>
      </div>
      <form
        className="access__form"
        noValidate
        aria-label={t("access.reset.newTitle")}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
        {/* The account's address as a visible, locked field: password managers store it with
            the new password. */}
        <TextField
          label={t("access.reset.email")}
          type="email"
          name="username"
          autoComplete="username"
          readOnly
          value={link.data.email}
          onValueChange={() => {}}
        />
        <PasswordField
          ref={passwordRef}
          label={t("access.reset.newPassword")}
          name="new-password"
          autoComplete="new-password"
          showStrength
          showRules
          readOnly={save.isPending}
          value={password}
          onValueChange={(value) => {
            setPassword(value);
            setError(undefined);
          }}
          error={error}
        />
        <p className="field__hint">{t("access.reset.endsSessions")}</p>
        <button
          type="submit"
          className="button button--primary button--block access__submit"
          aria-disabled={save.isPending}
        >
          {save.isPending ? <span className="access__spinner" aria-hidden="true" /> : null}
          {save.isPending ? t("access.reset.saving") : t("access.reset.save")}
        </button>
      </form>
    </>
  );
}
