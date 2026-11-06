import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, type KeyboardEvent, useEffect, useId, useRef, useState } from "react";
import { forgetAccountData, logout, meQuery } from "../../api/auth";
import { isApiError } from "../../api/client";
import { AccessNotice } from "../../auth/AccessLayout";
import { PasswordField } from "../../auth/PasswordField";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { Notice, useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import {
  confirmFactor,
  confirmPasskeyOptions,
  confirmPassword,
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
import { RecentSignIns } from "./RecentSignIns";
import { createPasskey, isPasskeyCancelled, passkeysAvailable } from "./webauthn";
import "../settings/settings.css";
import "./security.css";

const KIND_LABEL: Record<"oidc" | "saml" | "ldap", MessageKey> = {
  oidc: "sso.kind.oidc",
  saml: "sso.kind.saml",
  ldap: "sso.kind.ldap",
};

/** "1 Passkey", "3 Passkeys". */
function passkeyCount(t: Translate, count: number): string {
  return count === 1
    ? t("security.account.summaryPasskeyOne")
    : t("security.account.summaryPasskeys", { count });
}

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
 * the app, passkeys and recovery codes, with the recent sign-ins beside them; the dialogs of
 * frames 4B to 4F.
 */
export function SecuritySection({ email }: { email: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: securityKeys.status,
    queryFn: ({ signal }) => fetchSecurity(signal),
  });
  const notice = useNotice();
  const [open, setOpen] = useState<Open>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const ids = useId();
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

  const summary =
    s.totp !== null && s.passkeys.length > 0
      ? t("security.account.summaryBoth", { passkeys: passkeyCount(t, s.passkeys.length) })
      : s.totp !== null
        ? t("security.account.summaryApp")
        : s.passkeys.length > 0
          ? passkeyCount(t, s.passkeys.length)
          : t("security.account.none");
  const linked = s.linked ?? [];
  /** "Set up" in the quiet line: a passkey where allowed, otherwise the app. */
  const firstMethod: Open = s.allowed.passkey ? { kind: "passkey" } : { kind: "totp" };

  return (
    <div className="settings-profile security-page">
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {s.required ? (
        <AccessNotice
          tone="info"
          icon="shieldCheck"
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
          {s.allowed.passkey || s.allowed.totp ? (
            <button
              type="button"
              className="button button--secondary button--small"
              aria-label={t("security.account.setUpFactor")}
              onClick={() => setOpen(firstMethod)}
            >
              {t("security.account.setUp")}
            </button>
          ) : null}
        </div>
      ) : null}
      {s.lockedUntil === null ? null : (
        <AccessNotice
          tone="danger"
          icon="clock"
          title={t("security.account.locked", { time: dateTime(s.lockedUntil) })}
        />
      )}

      <div className="security-layout">
        <div className="security-layout__main">
          <section className="security-card" aria-labelledby={`${ids}-sign-in`}>
            <div className="security-card__head">
              <h3 className="security-card__title" id={`${ids}-sign-in`}>
                {t("security.account.signIn")}
              </h3>
            </div>
            {linked.map((link) => (
              <div className="security-row" key={`${link.provider}-${link.kind}`}>
                <div className="security-row__text">
                  <h4 className="security-row__title">{t("security.account.linked")}</h4>
                  <p className="security-row__meta">
                    {t("security.account.linkedProvider", {
                      provider: link.provider,
                      kind: t(KIND_LABEL[link.kind]),
                    })}
                    {link.username === null ? null : (
                      <>
                        {" · "}
                        <span className="security-row__mono">{link.username}</span>
                      </>
                    )}
                    {" · "}
                    {t("security.account.linkedFrom")}
                  </p>
                </div>
                <span className="security-chip">
                  {t("security.account.managedBy", { provider: link.provider })}
                </span>
              </div>
            ))}
            <div className="security-row">
              <div className="security-row__text">
                <h4 className="security-row__title">{t("security.account.password")}</h4>
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
                  className="button button--secondary button--small"
                >
                  {t("security.account.changePassword")}
                </Link>
              ) : null}
            </div>
          </section>

          <section className="security-card" aria-labelledby={`${ids}-factor`}>
            <div className="security-card__head">
              <h3 className="security-card__title" id={`${ids}-factor`}>
                {t("security.account.secondFactor")}
              </h3>
              <span className="security-chip">
                {count === 0 ? null : <Icon name="shieldCheck" />}
                {summary}
              </span>
            </div>

            <div className="security-row">
              <div className="security-row__text">
                <h4 className="security-row__title">
                  <Icon name="phone" />
                  {t("security.setup.app")}
                </h4>
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
                    className="button button--secondary button--small"
                    onClick={() => setOpen({ kind: "totp" })}
                  >
                    {s.totp === null ? t("security.account.setUp") : t("security.account.redo")}
                  </button>
                ) : null}
                {s.totp === null ? null : (
                  <button
                    type="button"
                    className="button button--ghost button--small security-remove"
                    onClick={() => askRemove({ kind: "removeTotp" }, t("security.setup.app"))}
                  >
                    {t("security.account.remove")}
                  </button>
                )}
              </div>
            </div>

            <div className="security-passkeys">
              <div className="security-passkeys__head">
                <div className="security-row__text">
                  <h4 className="security-row__title">
                    <Icon name="passkey" />
                    {t("security.account.passkeys")}
                    <span className="security-count">{s.passkeys.length}</span>
                  </h4>
                  <p className="security-row__meta">{t("security.account.passkeysLead")}</p>
                </div>
                {s.allowed.passkey ? (
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => setOpen({ kind: "passkey" })}
                  >
                    <Icon name="plus" />
                    {t("security.account.addPasskey")}
                  </button>
                ) : null}
              </div>
              {s.passkeys.length === 0 ? null : (
                <div className="security-passkeys__frame">
                  <table className="security-passkeys__table">
                    <thead>
                      <tr>
                        <th scope="col">{t("security.account.colName")}</th>
                        <th scope="col">{t("security.account.colAdded")}</th>
                        <th scope="col">{t("security.account.colUsed")}</th>
                        <th scope="col">
                          <span className="visually-hidden">
                            {t("security.account.colActions")}
                          </span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.passkeys.map((passkey) =>
                        renaming === passkey.id ? (
                          <tr key={passkey.id}>
                            <td colSpan={4}>
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
                            </td>
                          </tr>
                        ) : (
                          <tr key={passkey.id}>
                            <td>
                              <span className="security-passkeys__name">
                                <Icon name="passkey" />
                                {passkey.name}
                              </span>
                            </td>
                            <td className="security-passkeys__when">{date(passkey.createdAt)}</td>
                            <td className="security-passkeys__when">
                              {passkey.lastUsedAt === null
                                ? t("security.account.never")
                                : dateTime(passkey.lastUsedAt)}
                            </td>
                            <td>
                              <div className="security-passkeys__actions">
                                <button
                                  type="button"
                                  className="button button--ghost button--small"
                                  aria-label={t("security.account.renameNamed", {
                                    name: passkey.name,
                                  })}
                                  onClick={() => setRenaming(passkey.id)}
                                >
                                  {t("security.account.rename")}
                                </button>
                                <button
                                  type="button"
                                  className="button button--ghost button--small security-remove"
                                  aria-label={t("security.account.removeNamed", {
                                    name: passkey.name,
                                  })}
                                  onClick={() =>
                                    askRemove({ kind: "removePasskey", passkey }, passkey.name)
                                  }
                                >
                                  {t("security.account.remove")}
                                </button>
                              </div>
                            </td>
                          </tr>
                        ),
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            <div className="security-row">
              <div className="security-row__text">
                <h4 className="security-row__title">
                  <Icon name="keyboard" />
                  {t("security.codes.list")}
                </h4>
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
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => setOpen({ kind: "regenerate" })}
                >
                  {t("security.account.regenerate")}
                </button>
              )}
            </div>
          </section>
        </div>
        <RecentSignIns />
      </div>

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
            <>
              <button type="button" className="button button--secondary" onClick={close}>
                {t("security.dialog.close")}
              </button>
              <button type="button" className="button button--secondary" disabled>
                {t("security.dialog.lastRemove")}
              </button>
            </>
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

/** Renames in the row: Enter or "Save" saves, Escape or "Cancel" cancels. */
function RenameField({
  passkey,
  onDone,
}: {
  passkey: PasskeyInfo;
  onDone: (name: string | null) => void;
}) {
  const { t } = useI18n();
  const [name, setName] = useState(passkey.name);
  const hintId = useId();
  const save = () => onDone(name.trim() === "" ? null : name.trim());
  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone(null);
    }
  }
  return (
    <div className="security-rename">
      <input
        className="input security-rename__input"
        aria-label={t("security.account.renameLabel", { name: passkey.name })}
        aria-describedby={hintId}
        value={name}
        maxLength={60}
        // biome-ignore lint/a11y/noAutofocus: the field replaces the row the person chose to rename.
        autoFocus
        onChange={(event) => setName(event.currentTarget.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="button button--secondary button--small" onClick={save}>
        {t("security.account.renameSave")}
      </button>
      <button
        type="button"
        className="button button--ghost button--small"
        onClick={() => onDone(null)}
      >
        {t("security.dialog.cancel")}
      </button>
      <span className="security-rename__hint" id={hintId}>
        {t("security.account.renameHint")}
      </span>
    </div>
  );
}

/**
 * Adding to an account that has a factor needs a fresh confirmation with it first; the first
 * factor of an account with a password needs the password. The dialogs ask for it in place
 * before they start.
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
  if (!hasFactor(status)) {
    return status.hasPassword ? (
      <ConfirmPasswordFirst onConfirmed={onConfirmed} />
    ) : (
      <SignInAgain />
    );
  }
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

function hasFactor(status: SecurityStatus): boolean {
  return status.totp !== null || status.passkeys.length > 0;
}

function needsConfirmation(status: SecurityStatus): boolean {
  if (hasFactor(status)) {
    return !isConfirmed(status);
  }
  const fresh = (until: number | null) => until !== null && until - 5_000 > Date.now();
  return status.hasPassword
    ? !fresh(status.passwordConfirmedUntil) && !fresh(status.providerSignInUntil)
    : !fresh(status.freshSignInUntil);
}

/**
 * The first second factor of an account without a password (it signs in through a provider or a
 * directory) needs a sign-in from the last minutes: the person signs out and in again, and comes
 * back here.
 */
function SignInAgain() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const signIn = useMutation({
    mutationFn: async () => {
      await queryClient.cancelQueries();
      await logout();
    },
    onSuccess: () => {
      forgetAccountData(queryClient);
      queryClient.setQueryData(meQuery.queryKey, null);
      const back = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login?redirect=${encodeURIComponent(back)}`);
    },
  });
  return (
    <>
      <p className="admin-dialog__text">{t("security.dialog.signInAgainText")}</p>
      {signIn.isError ? (
        <p className="admin-error" role="alert">
          {errorText(t, signIn.error)}
        </p>
      ) : null}
      <div className="admin-dialog__footer">
        <button
          type="button"
          className="button button--primary"
          aria-disabled={signIn.isPending}
          onClick={() => {
            if (!signIn.isPending) {
              signIn.mutate();
            }
          }}
        >
          {t("security.dialog.signInAgain")}
        </button>
      </div>
    </>
  );
}

/**
 * The account's password before its first second factor: a session someone took over cannot set
 * up a factor of its own and keep the account.
 */
function ConfirmPasswordFirst({ onConfirmed }: { onConfirmed: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
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
      setError(t("security.dialog.passwordRequired"));
      fieldRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await confirmPassword(password);
      await queryClient.invalidateQueries({ queryKey: securityKeys.status });
      onConfirmed();
    } catch (failure) {
      setError(
        isApiError(failure, "validation")
          ? t("security.dialog.passwordWrong")
          : errorText(t, failure),
      );
      fieldRef.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" noValidate onSubmit={(event) => void submit(event)}>
      <p className="admin-dialog__text">{t("security.dialog.passwordFirst")}</p>
      <PasswordField
        ref={fieldRef}
        label={t("security.dialog.passwordLabel")}
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
      <div className="admin-dialog__footer">
        <button type="submit" className="button button--primary" aria-disabled={busy}>
          {t("security.factor.confirm")}
        </button>
      </div>
    </form>
  );
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
