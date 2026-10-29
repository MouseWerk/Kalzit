import { useMutation, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { isApiError } from "../api/client";
import { TextField } from "../components/TextField";
import { useI18n } from "../i18n/i18n";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { AccessAlert, AccessLayout, AccessNotice } from "./AccessLayout";
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
import "./links.css";
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
 * Password reset (board docs/design/blueprint/Identity.dc.html, frame 3D): without a link, ask
 * for one by email address, answered the same whether or not an account has it; with a link,
 * set the new password. A server without mail says that an admin can help instead.
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
      <Link to="/login" className="access__quiet-link">
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
      <>
        <div className="access__head">
          <h1>{t("access.reset.title")}</h1>
        </div>
        <div className="access__card">
          <AccessNotice
            tone="info"
            icon="lock"
            title={t("access.reset.noMailTitle")}
            detail={t("access.reset.noMailText")}
          />
        </div>
        <BackToSignIn />
      </>
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
    return (
      <>
        <div className="access__head">
          <h1>{t("access.reset.sentTitle")}</h1>
        </div>
        <div className="access__card" role="status">
          <p>{t("access.reset.sentText", { email: sentTo })}</p>
          <p className="field__hint">
            {waiting
              ? t("access.reset.sentRetryIn", { time: formatWait(left) })
              : t("access.reset.sentRetry")}
          </p>
          {waiting ? null : (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => {
                send.reset();
                setSentTo(null);
              }}
            >
              {t("access.reset.again")}
            </button>
          )}
        </div>
        <BackToSignIn />
      </>
    );
  }

  const failed =
    send.error === null
      ? null
      : waiting
        ? t("access.reset.rateLimited", { time: formatWait(left) })
        : t(`errors.${isApiError(send.error) ? send.error.code : "internal"}`);
  return (
    <>
      <div className="access__head">
        <h1>{t("access.reset.title")}</h1>
        <p className="access__lead">{t("access.reset.lead")}</p>
      </div>
      <form
        className="access__card"
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
          className="button button--primary button--block access__submit"
          aria-disabled={send.isPending || waiting}
        >
          {t("access.reset.send")}
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
  const [everywhere, setEverywhere] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);
  const passwordRef = useRef<HTMLInputElement>(null);
  const save = useMutation({
    mutationFn: () => completePasswordReset(token, password, everywhere),
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
      <div className="access__card link-state">
        <h1 className="link-state__title">{t("access.reset.invalidTitle")}</h1>
        <p className="access__lead">{t("access.reset.invalidText")}</p>
        <button type="button" className="button button--primary" onClick={onRequestNew}>
          {t("access.reset.newLink")}
        </button>
      </div>
    );
  }
  if (save.isSuccess) {
    return (
      <div className="access__card link-state" role="status">
        <h1 className="link-state__title">{t("access.reset.doneTitle")}</h1>
        <p className="access__lead">
          {everywhere ? t("access.reset.doneText") : t("access.reset.doneTextKept")}
        </p>
        <Link to="/login" className="button button--primary">
          {t("access.reset.signIn")}
        </Link>
      </div>
    );
  }
  if (link.error !== null) {
    return (
      <AccessNotice
        tone="danger"
        icon="alert"
        title={
          isApiError(link.error, "rate_limited")
            ? t("access.links.rateLimited")
            : t(`errors.${isApiError(link.error) ? link.error.code : "internal"}`)
        }
      />
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
        <p className="access__lead">{t("access.reset.newFor", { email: link.data.email })}</p>
      </div>
      <form
        className="access__card"
        noValidate
        aria-label={t("access.reset.newTitle")}
        onSubmit={onSubmit}
        onKeyDown={preventComposingSubmit}
      >
        {/* The account's address, for password managers. */}
        <input type="hidden" name="username" autoComplete="username" value={link.data.email} />
        <AccessAlert>
          {failed === null ? null : <AccessNotice tone="danger" icon="alert" title={failed} />}
        </AccessAlert>
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
        <div className="link-actions link-actions--split">
          <label className="access__check">
            <input
              type="checkbox"
              checked={everywhere}
              disabled={save.isPending}
              onChange={(event) => setEverywhere(event.currentTarget.checked)}
            />
            <span>{t("access.reset.signOutEverywhere")}</span>
          </label>
          <button type="submit" className="button button--primary" aria-disabled={save.isPending}>
            {t("access.reset.save")}
          </button>
        </div>
      </form>
    </>
  );
}
