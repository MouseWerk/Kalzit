import { type FormEvent, useId, useRef, useState } from "react";
import type { Me } from "../../api/auth";
import { isApiError } from "../../api/client";
import { AccessAlert, AccessNotice } from "../../auth/AccessLayout";
import { PasswordField } from "../../auth/PasswordField";
import { Icon } from "../../components/Icon";
import { useI18n } from "../../i18n/i18n";
import { errorText } from "../admin/errors";
import {
  finishSetup,
  type Prompt,
  reasonOf,
  type SetupMethod,
  type SignedIn,
  signInPasskeyOptions,
  signInWith,
  signInWithPassword,
  startSetupPasskey,
  startSetupTotp,
  type TotpSetup,
} from "./api";
import { FactorForm } from "./FactorForm";
import { RecoveryCodesPanel, TotpSetupPanel } from "./parts";
import { createPasskey, isPasskeyCancelled, passkeysAvailable } from "./webauthn";
import "./security.css";

/** Who is signing in, with the way back out (frames 2A and 2D). */
function SigningInAs({ email, onSignOut }: { email: string; onSignOut: () => void }) {
  const { t } = useI18n();
  return (
    <p className="factor__who">
      <span>{t("security.signIn.as")}</span>
      <strong translate="no">{email}</strong>
      <span aria-hidden="true">·</span>
      <button type="button" className="access__quiet-link" onClick={onSignOut}>
        {t("security.signIn.signOut")}
      </button>
    </p>
  );
}

/**
 * The second step of the sign-in (frames 2A to 2D): confirm with a passkey, the app's code or a
 * recovery code. After a recovery code it says how many are left before going on.
 */
export function SecondFactorStep({
  prompt,
  onSignedIn,
  onSignOut,
  onExpired,
}: {
  prompt: Prompt;
  /** Signed in; `to` is where to go instead of the page that was asked for. */
  onSignedIn: (me: Me, to?: string) => void;
  onSignOut: () => void;
  onExpired: () => void;
}) {
  const { t } = useI18n();
  const [afterRecovery, setAfterRecovery] = useState<{ me: Me; left: number } | null>(null);

  async function submit(proof: Parameters<typeof signInWith>[0]) {
    let signedIn: SignedIn;
    try {
      signedIn = await signInWith(proof);
    } catch (error) {
      if (isApiError(error, "unauthenticated")) {
        onExpired();
        return;
      }
      throw error;
    }
    if (signedIn.recoveryCodesRemaining !== undefined) {
      setAfterRecovery({ me: signedIn.me, left: signedIn.recoveryCodesRemaining });
      return;
    }
    onSignedIn(signedIn.me);
  }

  if (afterRecovery !== null) {
    return (
      <>
        <div className="access__head">
          <h1>{t("security.signIn.title")}</h1>
        </div>
        <div className="access__card">
          <AccessNotice
            tone="info"
            icon="check"
            title={t("security.signIn.recoveryUsed")}
            detail={t("security.signIn.recoveryLeft", { count: afterRecovery.left })}
          />
          <div className="access__foot">
            <button
              type="button"
              className="button button--primary"
              onClick={() => onSignedIn(afterRecovery.me, "/settings/account-security")}
            >
              {t("security.signIn.newCodes")}
            </button>
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onSignedIn(afterRecovery.me)}
            >
              {t("security.signIn.later")}
            </button>
          </div>
        </div>
      </>
    );
  }

  return (
    <>
      <div className="access__head">
        <h1>{t("security.signIn.title")}</h1>
        <p className="access__lead">{t("security.signIn.lead")}</p>
      </div>
      <div className="access__card">
        <FactorForm
          methods={prompt.methods}
          lastUsed={prompt.lastUsed}
          lockedUntil={prompt.lockedUntil}
          passkeyOptions={async () => {
            try {
              return await signInPasskeyOptions();
            } catch (error) {
              if (isApiError(error, "unauthenticated")) {
                onExpired();
              }
              throw error;
            }
          }}
          submit={submit}
        />
      </div>
      <SigningInAs email={prompt.email} onSignOut={onSignOut} />
    </>
  );
}

/**
 * The account's own password, once, after a provider linked its identity to the account by the
 * email address and the account has no second factor to prove it with. Then the person is signed
 * in, or sets up a second factor the account must have (`onPrompt`).
 */
export function LinkPasswordStep({
  prompt,
  onSignedIn,
  onSignOut,
  onExpired,
  onPrompt,
}: {
  prompt: Prompt;
  onSignedIn: (me: Me, to?: string) => void;
  onSignOut: () => void;
  onExpired: () => void;
  onPrompt: (next: Prompt) => void;
}) {
  const { t } = useI18n();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (password === "") {
      setError(t("security.linkPassword.required"));
      fieldRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      const result = await signInWithPassword(password);
      if ("secondFactor" in result) {
        onPrompt(result.secondFactor);
        return;
      }
      onSignedIn(result.me);
    } catch (failure) {
      if (isApiError(failure, "unauthenticated")) {
        onExpired();
        return;
      }
      setError(
        isApiError(failure, "invalid_credentials")
          ? t("security.linkPassword.wrong")
          : errorText(t, failure),
      );
      fieldRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="access__head">
        <h1>{t("security.linkPassword.title")}</h1>
        <p className="access__lead">{t("security.linkPassword.lead")}</p>
      </div>
      <form className="access__card" noValidate onSubmit={submit}>
        <PasswordField
          ref={fieldRef}
          label={t("security.linkPassword.label")}
          name="password"
          autoComplete="current-password"
          value={password}
          onValueChange={(value) => {
            setPassword(value);
            setError(undefined);
          }}
          error={error}
          readOnly={busy}
        />
        <div className="access__foot">
          <button type="submit" className="button button--primary" aria-disabled={busy}>
            {t("security.linkPassword.submit")}
          </button>
        </div>
      </form>
      <SigningInAs email={prompt.email} onSignOut={onSignOut} />
    </>
  );
}

const STEPS = ["security.setup.step1", "security.setup.step2", "security.setup.step3"] as const;

function StepList({ current }: { current: 1 | 2 | 3 }) {
  const { t } = useI18n();
  return (
    <ol className="setup-steps__list" aria-label={t("security.setup.stepOf", { n: current })}>
      {STEPS.map((key, index) => {
        const n = index + 1;
        const state = n < current ? "done" : n === current ? "current" : "next";
        return (
          <li
            key={key}
            className={`setup-steps__item setup-steps__item--${state}`}
            aria-current={n === current ? "step" : undefined}
          >
            <span className="setup-steps__mark" aria-hidden="true">
              {n < current ? <Icon name="check" /> : n}
            </span>
            <span>{t(key)}</span>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * The forced setup after the first step (frame 2C): the server or an organization requires a
 * second factor and the account has none. Method, setup, then the recovery codes; only then the
 * app opens.
 */
export function SecondFactorSetup({
  prompt,
  onSignedIn,
  onSignOut,
  onExpired,
}: {
  prompt: Prompt;
  onSignedIn: (me: Me) => void;
  onSignOut: () => void;
  onExpired: () => void;
}) {
  const { t } = useI18n();
  const choices: SetupMethod[] = [
    ...(prompt.allowed.passkey ? (["passkey"] as const) : []),
    ...(prompt.allowed.totp ? (["totp"] as const) : []),
  ];
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [method, setMethod] = useState<SetupMethod>(choices[0] ?? "totp");
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ me: Me; codes: string[] } | null>(null);
  const [saved, setSaved] = useState(false);
  const radios = useRef<(HTMLButtonElement | null)[]>([]);
  const groupId = useId();

  const lead =
    prompt.requiredBy?.kind === "org"
      ? t("security.setup.leadOrg", { org: prompt.requiredBy.name })
      : t("security.setup.leadServer");

  function fail(failure: unknown) {
    if (isApiError(failure, "unauthenticated")) {
      onExpired();
      return;
    }
    if (isApiError(failure, "invalid_code")) {
      setCodeError(t("security.totp.wrong"));
      return;
    }
    if (reasonOf(failure) === "second_factor.setup_expired") {
      setSetup(null);
      setStep(1);
      setError(t("security.totp.expired"));
      return;
    }
    setError(errorText(t, failure));
  }

  async function next() {
    if (busy) {
      return;
    }
    setError(null);
    if (method === "totp") {
      setBusy(true);
      try {
        setSetup(await startSetupTotp());
        setStep(2);
      } catch (failure) {
        fail(failure);
      } finally {
        setBusy(false);
      }
      return;
    }
    setStep(2);
  }

  async function finish(input: Parameters<typeof finishSetup>[0]) {
    setBusy(true);
    setError(null);
    try {
      const result = await finishSetup(input);
      setDone({ me: result.me, codes: result.recoveryCodes ?? [] });
      setStep(3);
    } catch (failure) {
      fail(failure);
    } finally {
      setBusy(false);
    }
  }

  async function createPasskeyNow() {
    if (busy) {
      return;
    }
    if (!passkeysAvailable()) {
      setError(t("security.factor.passkeyUnavailable"));
      return;
    }
    setBusy(true);
    setError(null);
    let credential: unknown;
    try {
      credential = await createPasskey(await startSetupPasskey());
    } catch (failure) {
      setBusy(false);
      if (isPasskeyCancelled(failure)) {
        setError(t("security.factor.passkeyCancelledDetail"));
      } else {
        fail(failure);
      }
      return;
    }
    setBusy(false);
    await finish({ method: "passkey", credential });
  }

  function move(index: number) {
    const next = choices[(index + choices.length) % choices.length];
    if (next !== undefined) {
      setMethod(next);
      radios.current[choices.indexOf(next)]?.focus();
    }
  }

  return (
    <>
      <StepList current={step} />
      <div className="access__head">
        <h1>
          {step === 1
            ? t("security.setup.title")
            : step === 2
              ? method === "totp"
                ? t("security.setup.appTitle")
                : t("security.setup.passkeyTitle")
              : t("security.codes.title")}
        </h1>
        <p className="access__lead">
          {step === 1 ? lead : step === 2 ? null : t("security.codes.lead")}
        </p>
      </div>
      <div className="access__card">
        <AccessAlert>
          {error === null ? null : <AccessNotice tone="danger" icon="alert" title={error} />}
        </AccessAlert>
        {step === 1 ? (
          <>
            <div className="factor-tiles" role="radiogroup" aria-labelledby={groupId}>
              <span id={groupId} className="access__subhead">
                {t("security.setup.choose")}
              </span>
              {choices.map((choice, index) => (
                // biome-ignore lint/a11y/useSemanticElements: radio buttons as buttons, as in the settings
                <button
                  key={choice}
                  ref={(element) => {
                    radios.current[index] = element;
                  }}
                  type="button"
                  role="radio"
                  aria-checked={method === choice}
                  tabIndex={method === choice ? 0 : -1}
                  className="factor-tile"
                  onClick={() => setMethod(choice)}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowRight") {
                      event.preventDefault();
                      move(index + 1);
                    } else if (event.key === "ArrowUp" || event.key === "ArrowLeft") {
                      event.preventDefault();
                      move(index - 1);
                    }
                  }}
                >
                  <Icon name={choice === "passkey" ? "passkey" : "phone"} />
                  <span className="factor-tile__text">
                    <span>
                      {choice === "passkey" ? t("security.setup.passkey") : t("security.setup.app")}
                      {choice === "passkey" ? (
                        <span className="factor-tile__hint">
                          {" "}
                          · {t("security.setup.recommended")}
                        </span>
                      ) : null}
                    </span>
                    <span className="factor-tile__hint">
                      {choice === "passkey"
                        ? t("security.setup.passkeyHint")
                        : t("security.setup.appHint")}
                    </span>
                  </span>
                  {method === choice ? (
                    <span className="factor-tile__check">
                      <Icon name="check" />
                    </span>
                  ) : null}
                </button>
              ))}
            </div>
            <p className="access__below">{t("security.setup.later")}</p>
            <div className="access__foot">
              <button type="button" className="button button--secondary" onClick={onSignOut}>
                {t("security.signIn.signOut")}
              </button>
              <button
                type="button"
                className="button button--primary"
                aria-disabled={busy}
                onClick={() => void next()}
              >
                {t("security.setup.next")}
              </button>
            </div>
          </>
        ) : null}
        {step === 2 && method === "totp" && setup !== null ? (
          <form
            className="factor"
            noValidate
            onSubmit={(event) => {
              event.preventDefault();
              if (/^\d{6}$/.test(code.replace(/\s/g, ""))) {
                void finish({ method: "totp", code: code.replace(/\s/g, "") });
              } else {
                setCodeError(t("security.factor.codeRequired"));
              }
            }}
          >
            <TotpSetupPanel
              setup={setup}
              code={code}
              busy={busy}
              error={codeError}
              onCodeChange={(value) => {
                setCode(value);
                setCodeError(undefined);
              }}
              onComplete={(digits) => void finish({ method: "totp", code: digits })}
            />
            <div className="access__foot">
              <button type="button" className="button button--secondary" onClick={() => setStep(1)}>
                {t("security.setup.back")}
              </button>
              <button type="submit" className="button button--primary" aria-disabled={busy}>
                {t("security.setup.check")}
              </button>
            </div>
          </form>
        ) : null}
        {step === 2 && method === "passkey" ? (
          <div className="factor">
            <p>{t("security.setup.passkeyLead")}</p>
            <div className="access__foot">
              <button type="button" className="button button--secondary" onClick={() => setStep(1)}>
                {t("security.setup.back")}
              </button>
              <button
                type="button"
                className="button button--primary"
                aria-disabled={busy}
                onClick={() => void createPasskeyNow()}
              >
                <Icon name="passkey" />
                {busy ? t("security.setup.passkeyCreating") : t("security.setup.passkeyStart")}
              </button>
            </div>
          </div>
        ) : null}
        {step === 3 && done !== null ? (
          <RecoveryCodesPanel
            codes={done.codes}
            account={prompt.email}
            saved={saved}
            onSavedChange={setSaved}
          >
            <button
              type="button"
              className="button button--primary button--block"
              aria-disabled={!saved}
              onClick={() => {
                if (saved) {
                  onSignedIn(done.me);
                }
              }}
            >
              {t("security.setup.done")}
            </button>
          </RecoveryCodesPanel>
        ) : null}
      </div>
      {step === 3 ? null : <SigningInAs email={prompt.email} onSignOut={onSignOut} />}
    </>
  );
}
