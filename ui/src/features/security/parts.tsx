import { type ReactNode, type Ref, useId, useState } from "react";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import type { TotpSetup } from "./api";
import "./security.css";

/** Six digits, with or without spaces; what the person typed otherwise stays as it is. */
export function digitsOf(text: string): string {
  return text.replace(/[\s-]/g, "");
}

/**
 * The field of a six-digit code. It takes the code with or without spaces and sends it on its own
 * at the sixth digit; Enter sends what is there.
 */
export function CodeField({
  label,
  value,
  onValueChange,
  onComplete,
  error,
  hint,
  readOnly,
  ref,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  onComplete: (code: string) => void;
  error?: string | undefined;
  hint?: string | undefined;
  readOnly?: boolean;
  ref?: Ref<HTMLInputElement> | undefined;
}) {
  return (
    <div className="factor__code">
      <TextField
        {...(ref === undefined ? {} : { ref })}
        label={label}
        name="one-time-code"
        autoComplete="one-time-code"
        inputMode="numeric"
        spellCheck={false}
        maxLength={9}
        readOnly={readOnly}
        value={value}
        hint={hint}
        error={error}
        onValueChange={(next) => {
          onValueChange(next);
          const digits = digitsOf(next);
          if (/^\d{6}$/.test(digits) && digitsOf(value) !== digits) {
            onComplete(digits);
          }
        }}
      />
    </div>
  );
}

/** The QR code the server computed, drawn in the theme-independent QR colors. */
export function QrImage({ setup }: { setup: TotpSetup }) {
  const { t } = useI18n();
  if (setup.qr === null) {
    return null;
  }
  // Four modules of quiet zone on every side, as scanners expect.
  const size = setup.qr.size + 8;
  return (
    <svg
      className="totp-setup__qr"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("security.totp.qrLabel")}
      shapeRendering="crispEdges"
    >
      <path transform="translate(4 4)" d={setup.qr.path} />
    </svg>
  );
}

/** Copies `text` and says so on the button for a moment. */
function CopyButton({ text, label, done }: { text: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="button button--secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 2000);
        });
      }}
    >
      <Icon name={copied ? "check" : "copy"} />
      <span aria-live="polite">{copied ? done : label}</span>
    </button>
  );
}

/**
 * Setting up an authenticator app (frame 4B): the QR code and the key to type by hand, then the
 * first code from the app, which the server checks before it keeps the key.
 */
export function TotpSetupPanel({
  setup,
  code,
  onCodeChange,
  onComplete,
  error,
  busy,
  codeRef,
}: {
  setup: TotpSetup;
  code: string;
  onCodeChange: (value: string) => void;
  onComplete: (code: string) => void;
  error?: string | undefined;
  busy: boolean;
  codeRef?: Ref<HTMLInputElement> | undefined;
}) {
  const { t } = useI18n();
  return (
    <div className="totp-setup">
      <p className="totp-setup__step">{t("security.totp.scan")}</p>
      <div className="totp-setup__scan">
        <QrImage setup={setup} />
        <div className="totp-setup__manual">
          <span>{t("security.totp.manual")}</span>
          <span className="totp-setup__key" translate="no">
            {setup.secret}
          </span>
          <span className="totp-setup__meta">
            {t("security.totp.meta", { issuer: setup.issuer })}
          </span>
        </div>
      </div>
      <div className="recovery-codes__actions">
        <CopyButton
          text={setup.secret.replace(/\s/g, "")}
          label={t("security.totp.copyKey")}
          done={t("security.totp.copied")}
        />
        {/* On a phone the app can take the key straight from the link. */}
        <a className="button button--ghost" href={setup.uri}>
          {t("security.totp.open")}
        </a>
      </div>
      <p className="totp-setup__step">{t("security.totp.codeStep")}</p>
      <CodeField
        ref={codeRef}
        label={t("security.factor.code")}
        value={code}
        readOnly={busy}
        onValueChange={onCodeChange}
        onComplete={onComplete}
        error={error}
      />
    </div>
  );
}

/** The codes as a text file. */
function download(codes: readonly string[], header: string) {
  const text = [header, "", ...codes, ""].join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "kalzit-recovery-codes.txt";
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/**
 * Recovery codes, shown once (frame 4C): download, copy and print, and a check that they were put
 * away; `children` is the button that goes on, which the caller enables with `saved`.
 */
export function RecoveryCodesPanel({
  codes,
  account,
  saved,
  onSavedChange,
  children,
}: {
  codes: readonly string[];
  account: string;
  saved: boolean;
  onSavedChange: (saved: boolean) => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  const listId = useId();
  return (
    <div className="recovery-codes">
      <ol className="recovery-codes__list" id={listId} aria-label={t("security.codes.list")}>
        {codes.map((code, index) => (
          <li key={code} className="recovery-codes__item">
            <span className="recovery-codes__number" aria-hidden="true">
              {index + 1}
            </span>
            <span translate="no">{code}</span>
          </li>
        ))}
      </ol>
      <div className="recovery-codes__actions">
        <button
          type="button"
          className="button button--secondary"
          onClick={() => download(codes, t("security.codes.fileHeader", { account }))}
        >
          <Icon name="download" />
          {t("security.codes.download")}
        </button>
        <CopyButton
          text={codes.join("\n")}
          label={t("security.codes.copy")}
          done={t("security.codes.copied")}
        />
        <button type="button" className="button button--secondary" onClick={() => window.print()}>
          {t("security.codes.print")}
        </button>
      </div>
      <p className="recovery-codes__note">{t("security.codes.note")}</p>
      <label className="recovery-codes__saved">
        <input
          type="checkbox"
          checked={saved}
          onChange={(event) => onSavedChange(event.currentTarget.checked)}
        />
        <span>{t("security.codes.saved")}</span>
      </label>
      {children}
    </div>
  );
}
