import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { AccessNotice } from "../../auth/AccessLayout";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { Notice, useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import {
  confirmFactor,
  confirmPasskeyOptions,
  fetchSecurity,
  newRecoveryCodes,
  type PasskeyInfo,
  reasonOf,
  removePasskey,
  removeTotp,
  renamePasskey,
  type SecurityStatus,
  savePasskey,
  saveTotp,
  securityKeys,
  startPasskey,
  startTotp,
  type TotpSetup,
} from "./api";
import { ConfirmFactorDialog, isConfirmed, methodsOf } from "./ConfirmFactorDialog";
import { FactorForm } from "./FactorForm";
import { RecoveryCodesPanel, TotpSetupPanel } from "./parts";
import { createPasskey, isPasskeyCancelled, passkeysAvailable } from "./webauthn";
import "../settings/settings.css";
import "./security.css";

type Open =
  | { kind: "totp" }
  | { kind: "passkey" }
  | { kind: "codes"; codes: string[] }
  | { kind: "removeTotp" }
  | { kind: "removePasskey"; passkey: PasskeyInfo }
  | { kind: "last"; name: string }
  | { kind: "regenerate" }
  | null;

/**
 * Account > Sign-in and security (frame 4A): the policy, the password, and the second factor with
 * the app, passkeys and recovery codes; the dialogs of frames 4B to 4F.
 */
export function SecuritySection({ email }: { email: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const status = useQuery({ queryKey: securityKeys.status, queryFn: fetchSecurity });
  const notice = useNotice();
  const [open, setOpen] = useState<Open>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: securityKeys.status });
  const date = (ms: number) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      ...(timeZone === null ? {} : { timeZone }),
    }).format(ms);
  const dateTime = (ms: number) =>
    new Intl.DateTimeFormat(language, {
      dateStyle: "medium",
      timeStyle: "short",
      ...(timeZone === null ? {} : { timeZone }),
    }).format(ms);

  if (status.data === undefined) {
    return <LoadState error={status.error} onRetry={() => void status.refetch()} />;
  }
  const s = status.data;
  const count = (s.totp === null ? 0 : 1) + s.passkeys.length;
  const isLast = count <= 1 && s.required;
  const close = () => setOpen(null);

  /** Asks before removing: the last method while required cannot go (frame 4E). */
  function askRemove(next: Open, name: string) {
    setOpen(isLast ? { kind: "last", name } : next);
  }

  const summary = [
    ...(s.totp === null ? [] : [t("security.account.summaryApp")]),
    ...(s.passkeys.length === 0
      ? []
      : [t("security.account.summaryPasskeys", { count: s.passkeys.length })]),
  ].join(" · ");

  return (
    <div className="settings-profile">
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {s.required ? (
        <AccessNotice
          tone="info"
          icon="lock"
          title={t("security.account.required")}
          detail={
            s.requiredBy?.kind === "org"
              ? t("security.account.requiredOrg", { org: s.requiredBy.name })
              : t("security.account.requiredServer")
          }
        />
      ) : count === 0 ? (
        <div className="security-quiet">
          <Icon name="shieldCheck" />
          <p>{t("security.account.protect")}</p>
        </div>
      ) : null}
      {s.lockedUntil === null ? null : (
        <AccessNotice
          tone="danger"
          icon="clock"
          title={t("security.account.locked", { time: dateTime(s.lockedUntil) })}
        />
      )}

      <section className="security-card" aria-label={t("security.account.signIn")}>
        <div className="security-row">
          <div className="security-row__text">
            <h3 className="security-row__title">{t("security.account.password")}</h3>
            <p className="security-row__meta">
              {s.hasPassword
                ? t("security.account.passwordMeta")
                : t("security.account.noPassword")}
            </p>
          </div>
          {s.hasPassword ? (
            <Link
              to="/settings/$section"
              params={{ section: "profile" }}
              className="button button--secondary"
            >
              {t("security.account.changePassword")}
            </Link>
          ) : null}
        </div>
      </section>

      <section className="security-card" aria-label={t("security.account.secondFactor")}>
        <div className="security-row">
          <div className="security-row__text">
            <h3 className="security-row__title">
              <Icon name="shieldCheck" />
              {t("security.account.secondFactor")}
            </h3>
            <p className="security-row__meta">
              {count === 0 ? t("security.account.none") : summary}
            </p>
          </div>
        </div>

        <div className="security-row">
          <div className="security-row__text">
            <h3 className="security-row__title">
              <Icon name="phone" />
              {t("security.setup.app")}
            </h3>
            <p className="security-row__meta">
              {s.totp === null
                ? t("security.setup.appHint")
                : s.totp.lastUsedAt === null
                  ? t("security.account.appSinceUnused", { date: date(s.totp.createdAt) })
                  : t("security.account.appSince", {
                      date: date(s.totp.createdAt),
                      used: date(s.totp.lastUsedAt),
                    })}
            </p>
          </div>
          <div className="security-row__actions">
            {s.allowed.totp ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setOpen({ kind: "totp" })}
              >
                {s.totp === null ? t("security.account.setUp") : t("security.account.redo")}
              </button>
            ) : null}
            {s.totp === null ? null : (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => askRemove({ kind: "removeTotp" }, t("security.setup.app"))}
              >
                {t("security.account.remove")}
              </button>
            )}
          </div>
        </div>

        <div className="security-passkeys">
          <div className="security-row__text">
            <h3 className="security-row__title">
              <Icon name="passkey" />
              {t("security.account.passkeys")}
              <span className="security-row__meta">{s.passkeys.length}</span>
            </h3>
            <p className="security-row__meta">{t("security.account.passkeysLead")}</p>
          </div>
          {s.allowed.passkey ? (
            <div className="security-row__actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setOpen({ kind: "passkey" })}
              >
                <Icon name="plus" />
                {t("security.account.addPasskey")}
              </button>
            </div>
          ) : null}
          {s.passkeys.length === 0 ? null : (
            <table className="security-passkeys__table">
              <thead>
                <tr>
                  <th scope="col">{t("security.account.colName")}</th>
                  <th scope="col">{t("security.account.colAdded")}</th>
                  <th scope="col">{t("security.account.colUsed")}</th>
                  <th scope="col">
                    <span className="visually-hidden">{t("security.account.colActions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {s.passkeys.map((passkey) => (
                  <tr key={passkey.id}>
                    <td>
                      {renaming === passkey.id ? (
                        <RenameField
                          passkey={passkey}
                          onDone={async (name) => {
                            setRenaming(null);
                            if (name !== null && name !== passkey.name) {
                              try {
                                await renamePasskey(passkey.id, name);
                                await refresh();
                                notice.show({
                                  message: t("security.account.passkeyRenamed", { name }),
                                });
                              } catch (failure) {
                                notice.showError(errorText(t, failure));
                              }
                            }
                          }}
                        />
                      ) : (
                        passkey.name
                      )}
                    </td>
                    <td>{date(passkey.createdAt)}</td>
                    <td>
                      {passkey.lastUsedAt === null
                        ? t("security.account.never")
                        : dateTime(passkey.lastUsedAt)}
                    </td>
                    <td>
                      <div className="security-passkeys__actions">
                        <button
                          type="button"
                          className="button button--ghost"
                          aria-label={t("security.account.renameNamed", { name: passkey.name })}
                          onClick={() => setRenaming(passkey.id)}
                        >
                          {t("security.account.rename")}
                        </button>
                        <button
                          type="button"
                          className="button button--ghost"
                          aria-label={t("security.account.removeNamed", { name: passkey.name })}
                          onClick={() =>
                            askRemove({ kind: "removePasskey", passkey }, passkey.name)
                          }
                        >
                          {t("security.account.remove")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="security-row">
          <div className="security-row__text">
            <h3 className="security-row__title">{t("security.codes.list")}</h3>
            <p className="security-row__meta">
              {s.recoveryCodes === null
                ? t("security.account.codesNone")
                : t("security.account.codesMeta", {
                    remaining: s.recoveryCodes.remaining,
                    total: s.recoveryCodes.total,
                    date: date(s.recoveryCodes.createdAt),
                  })}
            </p>
          </div>
          {count === 0 ? null : (
            <div className="security-row__actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setOpen({ kind: "regenerate" })}
              >
                {t("security.account.regenerate")}
              </button>
            </div>
          )}
        </div>
      </section>

      {open?.kind === "totp" ? (
        <TotpDialog
          status={s}
          onClose={close}
          onSaved={async (codes) => {
            await refresh();
            notice.show({ message: t("security.account.appSaved") });
            setOpen(codes === null ? null : { kind: "codes", codes });
          }}
        />
      ) : null}
      {open?.kind === "passkey" ? (
        <PasskeyDialog
          status={s}
          onClose={close}
          onSaved={async (name, codes) => {
            await refresh();
            notice.show({ message: t("security.account.passkeySaved", { name }) });
            setOpen(codes === null ? null : { kind: "codes", codes });
          }}
        />
      ) : null}
      {open?.kind === "codes" ? (
        <CodesDialog codes={open.codes} account={email} onClose={close} />
      ) : null}
      {open?.kind === "last" ? (
        <Dialog
          open
          title={t("security.dialog.lastTitle")}
          onClose={close}
          footer={
            <button type="button" className="button button--secondary" onClick={close}>
              {t("security.dialog.close")}
            </button>
          }
        >
          <p className="admin-dialog__text">{t("security.dialog.lastText", { name: open.name })}</p>
        </Dialog>
      ) : null}
      {open?.kind === "removeTotp" ? (
        <ConfirmFactorDialog
          open
          title={t("security.dialog.removeTitle", { name: t("security.setup.app") })}
          confirmLabel={t("security.dialog.removeConfirm")}
          status={s}
          onClose={close}
          action={async () => {
            await removeTotp();
            close();
            await refresh();
            notice.show({ message: t("security.account.appRemoved") });
          }}
        >
          {t("security.dialog.removeText")}
        </ConfirmFactorDialog>
      ) : null}
      {open?.kind === "removePasskey" ? (
        <ConfirmFactorDialog
          open
          title={t("security.dialog.removeTitle", { name: open.passkey.name })}
          confirmLabel={t("security.dialog.removeConfirm")}
          status={s}
          onClose={close}
          action={async () => {
            await removePasskey(open.passkey.id);
            close();
            await refresh();
            notice.show({
              message: t("security.account.passkeyRemoved", { name: open.passkey.name }),
            });
          }}
        >
          {t("security.dialog.removeText")}
        </ConfirmFactorDialog>
      ) : null}
      {open?.kind === "regenerate" ? (
        <ConfirmFactorDialog
          open
          title={t("security.dialog.regenTitle")}
          confirmLabel={t("security.dialog.regenConfirm")}
          status={s}
          onClose={close}
          action={async () => {
            const codes = await newRecoveryCodes();
            await refresh();
            notice.show({ message: t("security.account.codesMade") });
            setOpen({ kind: "codes", codes });
          }}
        >
          {t("security.dialog.regenText", { count: s.recoveryCodes?.remaining ?? 0 })}
        </ConfirmFactorDialog>
      ) : null}
    </div>
  );
}

/** Renames in the row: Enter saves, Escape cancels. */
function RenameField({
  passkey,
  onDone,
}: {
  passkey: PasskeyInfo;
  onDone: (name: string | null) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(passkey.name);
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      onDone(name.trim() === "" ? null : name.trim());
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone(null);
    }
  }
  return (
    <TextField
      label={t("security.account.renameLabel", { name: passkey.name })}
      hint={t("security.account.renameHint")}
      value={name}
      maxLength={60}
      autoFocus
      onValueChange={setName}
      onKeyDown={onKeyDown}
      onBlur={() => onDone(null)}
    />
  );
}

/**
 * Adding to an account that has a factor needs a fresh confirmation first; the dialogs ask for it
 * in place before they start.
 */
function ConfirmFirst({
  status,
  onConfirmed,
}: {
  status: SecurityStatus;
  onConfirmed: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  return (
    <>
      <p className="admin-dialog__text">{t("security.dialog.confirmFirst")}</p>
      <FactorForm
        methods={methodsOf(status)}
        passkeyOptions={confirmPasskeyOptions}
        submit={async (proof) => {
          await confirmFactor(proof);
          await queryClient.invalidateQueries({ queryKey: securityKeys.status });
          onConfirmed();
        }}
      />
    </>
  );
}

function needsConfirmation(status: SecurityStatus): boolean {
  return (status.totp !== null || status.passkeys.length > 0) && !isConfirmed(status);
}

/** Setting up the app (frame 4B). */
function TotpDialog({
  status,
  onClose,
  onSaved,
}: {
  status: SecurityStatus;
  onClose: () => void;
  onSaved: (codes: string[] | null) => void;
}) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(!needsConfirmation(status));
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const [failure, setFailure] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeRef = useRef<HTMLInputElement>(null);

  // A new key once the session may change the account (again after an expired setup).
  const needed = confirmed && setup === null;
  useEffect(() => {
    if (!needed) {
      return;
    }
    let current = true;
    startTotp().then(
      (started) => {
        if (current) {
          setSetup(started);
        }
      },
      (problem: unknown) => {
        if (!current) {
          return;
        }
        if (isApiError(problem, "confirmation_required")) {
          setConfirmed(false);
        } else {
          setFailure(errorText(t, problem));
        }
      },
    );
    return () => {
      current = false;
    };
  }, [needed, t]);

  async function save(digits: string) {
    if (busy) {
      return;
    }
    setBusy(true);
    setFailure(null);
    try {
      onSaved(await saveTotp(digits));
    } catch (problem) {
      if (isApiError(problem, "invalid_code")) {
        setError(t("security.totp.wrong"));
        codeRef.current?.select();
      } else if (reasonOf(problem) === "second_factor.setup_expired") {
        setFailure(t("security.totp.expired"));
        setSetup(null);
      } else {
        setFailure(errorText(t, problem));
      }
    } finally {
      setBusy(false);
    }
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const digits = code.replace(/\s/g, "");
    if (!/^\d{6}$/.test(digits)) {
      setError(t("security.factor.codeRequired"));
      codeRef.current?.focus();
      return;
    }
    void save(digits);
  }

  return (
    <Dialog open title={t("security.dialog.appTitle")} onClose={onClose} wide>
      {!confirmed ? (
        <ConfirmFirst status={status} onConfirmed={() => setConfirmed(true)} />
      ) : setup === null ? (
        failure === null ? (
          <p className="admin-dialog__text">{t("security.dialog.loading")}</p>
        ) : (
          <p className="admin-error" role="alert">
            {failure}
          </p>
        )
      ) : (
        <form className="form" noValidate onSubmit={onSubmit}>
          <TotpSetupPanel
            setup={setup}
            code={code}
            busy={busy}
            error={error}
            codeRef={codeRef}
            onCodeChange={(value) => {
              setCode(value);
              setError(undefined);
            }}
            onComplete={(digits) => void save(digits)}
          />
          {failure === null ? null : (
            <p className="admin-error" role="alert">
              {failure}
            </p>
          )}
          <div className="admin-dialog__footer">
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t("security.dialog.cancel")}
            </button>
            <button type="submit" className="button button--primary" aria-disabled={busy}>
              {t("security.dialog.appSave")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** Adding a passkey (frame 4D): a name, then the browser's dialog. */
function PasskeyDialog({
  status,
  onClose,
  onSaved,
}: {
  status: SecurityStatus;
  onClose: () => void;
  onSaved: (name: string, codes: string[] | null) => void;
}) {
  const { t } = useI18n();
  const [confirmed, setConfirmed] = useState(!needsConfirmation(status));
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) {
      return;
    }
    if (!passkeysAvailable()) {
      setFailure(t("security.factor.passkeyUnavailable"));
      return;
    }
    setBusy(true);
    setFailure(null);
    const chosen = name.trim() === "" ? t("security.dialog.passkeyDefault") : name.trim();
    try {
      const credential = await createPasskey(await startPasskey());
      onSaved(chosen, await savePasskey(chosen, credential));
    } catch (problem) {
      if (isPasskeyCancelled(problem)) {
        setFailure(t("security.factor.passkeyCancelledDetail"));
      } else if (isApiError(problem, "confirmation_required")) {
        setConfirmed(false);
      } else {
        setFailure(errorText(t, problem));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open
      title={t("security.account.addPasskey")}
      onClose={onClose}
      {...(confirmed ? { initialFocus: nameRef } : {})}
    >
      {!confirmed ? (
        <ConfirmFirst status={status} onConfirmed={() => setConfirmed(true)} />
      ) : (
        <form className="form" noValidate onSubmit={(event) => void create(event)}>
          <TextField
            ref={nameRef}
            label={t("security.dialog.passkeyName")}
            hint={t("security.dialog.passkeyNameHint")}
            value={name}
            maxLength={60}
            readOnly={busy}
            onValueChange={setName}
          />
          <p className="admin-dialog__text" aria-live="polite">
            {busy ? t("security.setup.passkeyLead") : null}
          </p>
          {failure === null ? null : (
            <p className="admin-error" role="alert">
              {failure}
            </p>
          )}
          <div className="admin-dialog__footer">
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t("security.dialog.cancel")}
            </button>
            <button type="submit" className="button button--primary" aria-disabled={busy}>
              {busy ? t("security.setup.passkeyCreating") : t("security.dialog.passkeyCreate")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

/** New recovery codes, shown once (frame 4C); Done only after the check. */
function CodesDialog({
  codes,
  account,
  onClose,
}: {
  codes: string[];
  account: string;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [saved, setSaved] = useState(false);
  return (
    <Dialog
      open
      title={t("security.codes.title")}
      onClose={() => {
        if (saved) {
          onClose();
        }
      }}
      wide
      footer={
        <button
          type="button"
          className="button button--primary"
          aria-disabled={!saved}
          onClick={() => {
            if (saved) {
              onClose();
            }
          }}
        >
          {t("security.setup.done")}
        </button>
      }
    >
      <p className="admin-dialog__text">{t("security.codes.lead")}</p>
      <RecoveryCodesPanel codes={codes} account={account} saved={saved} onSavedChange={setSaved} />
    </Dialog>
  );
}
