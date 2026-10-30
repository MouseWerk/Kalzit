import { type FormEvent, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { AccessNotice } from "../../auth/AccessLayout";
import { formatWait, useCountdown } from "../../auth/countdown";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { errorText } from "../admin/errors";
import { type FactorMethod, lockedUntilOf, type Proof, reasonOf } from "./api";
import { CodeField, digitsOf } from "./parts";
import { getPasskey, isPasskeyCancelled, passkeysAvailable } from "./webauthn";
import "./security.css";

type PasskeyState = "idle" | "waiting" | "cancelled" | "unavailable";

/**
 * Confirms with a factor the account has (frames 2A and 2B): a passkey first when there is one,
 * the six-digit code of the app, or a recovery code. Used by the second step of the sign-in and by
 * every fresh confirmation. `submit` sends the proof; it resolves on success and throws the
 * server's error otherwise, which this shows where it belongs.
 */
export function FactorForm({
  methods,
  lastUsed,
  passkeyOptions,
  submit,
  lockedUntil: lockedAtStart = null,
  submitLabel,
}: {
  methods: readonly FactorMethod[];
  lastUsed?: "passkey" | "totp" | null;
  passkeyOptions: () => Promise<unknown>;
  submit: (proof: Proof) => Promise<void>;
  lockedUntil?: number | null;
  /** The label of the code's button; "Confirm" by default. */
  submitLabel?: string;
}) {
  const { t, language } = useI18n();
  const hasPasskey = methods.includes("passkey");
  const hasApp = methods.includes("totp");
  const hasRecovery = methods.includes("recovery");
  const [mode, setMode] = useState<"main" | "recovery">(hasPasskey || hasApp ? "main" : "recovery");
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState("");
  const [fieldError, setFieldError] = useState<string | undefined>(undefined);
  const [wrong, setWrong] = useState(false);
  const [other, setOther] = useState<string | null>(null);
  const [passkey, setPasskey] = useState<PasskeyState>("idle");
  const [busy, setBusy] = useState(false);
  const [lockedUntil, setLockedUntil] = useState<number | null>(lockedAtStart);
  const codeRef = useRef<HTMLInputElement>(null);
  const recoveryRef = useRef<HTMLInputElement>(null);
  const left = useCountdown(lockedUntil);
  const locked = lockedUntil !== null && left > 0;

  function failed(error: unknown, field: HTMLInputElement | null) {
    const until = lockedUntilOf(error);
    if (until !== null) {
      setLockedUntil(until);
      return;
    }
    if (isApiError(error, "invalid_code") && reasonOf(error) !== "second_factor.passkey_refused") {
      setWrong(true);
      field?.select();
      field?.focus();
      return;
    }
    if (reasonOf(error) === "second_factor.passkey_refused") {
      setPasskey("cancelled");
      return;
    }
    setOther(errorText(t, error));
  }

  async function send(proof: Proof, field: HTMLInputElement | null) {
    if (busy) {
      return;
    }
    setBusy(true);
    setWrong(false);
    setOther(null);
    try {
      await submit(proof);
    } catch (error) {
      failed(error, field);
    } finally {
      setBusy(false);
    }
  }

  async function confirmWithPasskey() {
    if (busy || passkey === "waiting") {
      return;
    }
    if (!passkeysAvailable()) {
      setPasskey("unavailable");
      return;
    }
    setPasskey("waiting");
    setWrong(false);
    setOther(null);
    try {
      const credential = await getPasskey(await passkeyOptions());
      setPasskey("idle");
      await send({ method: "passkey", credential }, null);
    } catch (error) {
      if (isPasskeyCancelled(error)) {
        setPasskey("cancelled");
      } else {
        setPasskey("idle");
        failed(error, null);
      }
    }
  }

  function onCodeSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = digitsOf(code);
    if (!/^\d{6}$/.test(digits)) {
      setFieldError(t("security.factor.codeRequired"));
      codeRef.current?.focus();
      return;
    }
    void send({ method: "totp", code: digits }, codeRef.current);
  }

  function onRecoverySubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (recovery.trim() === "") {
      setFieldError(t("security.factor.recoveryRequired"));
      recoveryRef.current?.focus();
      return;
    }
    void send({ method: "recovery", code: recovery.trim() }, recoveryRef.current);
  }

  const time = (until: number) =>
    new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(until);

  let notice = null;
  if (locked && lockedUntil !== null) {
    notice = (
      <AccessNotice
        tone="danger"
        icon="clock"
        title={t("security.factor.locked", { time: time(lockedUntil) })}
        detail={t("security.factor.lockedDetail")}
      />
    );
  } else if (passkey === "cancelled") {
    notice = (
      <AccessNotice
        tone="info"
        icon="alert"
        title={t("security.factor.passkeyCancelled")}
        detail={t("security.factor.passkeyCancelledDetail")}
      />
    );
  } else if (passkey === "unavailable") {
    notice = (
      <AccessNotice tone="info" icon="alert" title={t("security.factor.passkeyUnavailable")} />
    );
  } else if (other !== null) {
    notice = <AccessNotice tone="danger" icon="alert" title={other} />;
  }

  const codeError =
    fieldError ??
    (wrong
      ? mode === "recovery"
        ? t("security.factor.recoveryWrongDetail")
        : t("security.factor.wrongDetail")
      : undefined);
  const backLabel =
    hasPasskey && hasApp
      ? t("security.factor.backBoth")
      : hasPasskey
        ? t("security.factor.backPasskey")
        : t("security.factor.backApp");
  // The method used last comes first; without a passkey the code's button is the main one.
  const passkeyFirst = hasPasskey && (lastUsed !== "totp" || !hasApp);

  const passkeyButton = hasPasskey ? (
    <button
      type="button"
      className={
        passkeyFirst
          ? "button button--primary button--block"
          : "button button--secondary button--block"
      }
      aria-disabled={busy || passkey === "waiting"}
      onClick={() => void confirmWithPasskey()}
    >
      <Icon name="passkey" />
      {passkey === "waiting" ? t("security.factor.passkeyWaiting") : t("security.factor.passkey")}
    </button>
  ) : null;

  return (
    <div className="factor">
      <div role="alert" aria-atomic="true">
        {notice}
        {wrong && notice === null ? (
          <AccessNotice
            tone="danger"
            icon="alert"
            title={
              mode === "recovery" ? t("security.factor.recoveryWrong") : t("security.factor.wrong")
            }
          />
        ) : null}
      </div>
      {mode === "main" ? (
        <>
          {passkeyFirst ? passkeyButton : null}
          {hasApp ? (
            <form className="factor" noValidate onSubmit={onCodeSubmit}>
              {hasPasskey ? (
                <p className="factor__or">
                  {passkeyFirst ? t("security.factor.or") : t("security.factor.appFirst")}
                </p>
              ) : null}
              <CodeField
                ref={codeRef}
                label={t("security.factor.code")}
                value={code}
                readOnly={busy || locked}
                onValueChange={(value) => {
                  setCode(value);
                  setFieldError(undefined);
                  setWrong(false);
                }}
                onComplete={(digits) => {
                  if (!locked) {
                    void send({ method: "totp", code: digits }, codeRef.current);
                  }
                }}
                error={codeError}
              />
              <button
                type="submit"
                className={
                  passkeyFirst
                    ? "button button--secondary button--block"
                    : "button button--primary button--block"
                }
                aria-disabled={busy || locked}
              >
                {locked
                  ? t("security.factor.retryIn", { time: formatWait(left) })
                  : (submitLabel ?? t("security.factor.confirm"))}
              </button>
            </form>
          ) : null}
          {passkeyFirst ? null : passkeyButton}
        </>
      ) : (
        <form className="factor" noValidate onSubmit={onRecoverySubmit}>
          <TextField
            ref={recoveryRef}
            label={t("security.factor.recovery")}
            hint={t("security.factor.recoveryHint")}
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            mono
            readOnly={busy || locked}
            value={recovery}
            onValueChange={(value) => {
              setRecovery(value);
              setFieldError(undefined);
              setWrong(false);
            }}
            error={codeError}
          />
          <button
            type="submit"
            className="button button--primary button--block"
            aria-disabled={busy || locked}
          >
            {locked
              ? t("security.factor.retryIn", { time: formatWait(left) })
              : (submitLabel ?? t("security.factor.confirm"))}
          </button>
        </form>
      )}
      <div className="factor__links">
        {mode === "main" && hasRecovery ? (
          <button
            type="button"
            className="access__quiet-link factor__link"
            onClick={() => {
              setMode("recovery");
              setWrong(false);
              setFieldError(undefined);
            }}
          >
            {t("security.factor.useRecovery")}
          </button>
        ) : null}
        {mode === "recovery" && (hasPasskey || hasApp) ? (
          <button
            type="button"
            className="access__quiet-link factor__link"
            onClick={() => {
              setMode("main");
              setWrong(false);
              setFieldError(undefined);
            }}
          >
            {backLabel}
          </button>
        ) : null}
      </div>
    </div>
  );
}
