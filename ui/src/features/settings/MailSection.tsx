import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useId, useState } from "react";
import { meQuery } from "../../api/auth";
import { isApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { ConfirmDialog } from "../admin/components/Dialog";
import { formatDateTime } from "../admin/components/format";
import { Notice, useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import type { Delivered } from "../admin/invitationsApi";
import { errorReason, reasonText } from "../datasources/reasons";
import {
  getMail,
  type MailField,
  type MailSecurity,
  type MailSettings,
  type MailView,
  mailKey,
  saveMail,
  sendTestMail,
} from "./mailApi";
import { RowFrame, Segmented } from "./rows";
import "./settings.css";
import "./mail.css";

/**
 * Verwaltung > E-Mail (board docs/design/blueprint/Identity.dc.html, frame 6): the mail server
 * Kalzit sends invitations and password links with. The fields depend on each other, so they
 * apply with one explicit Save, which the server checks by connecting and signing in; a test
 * mail with the values in the form comes first, and Save waits for it (frame 6B). Without a mail
 * server the page says what that means (frame 6C). Values from kalzit.toml or the environment
 * are shown read-only with their source.
 */
export function MailSection() {
  const view = useQuery({ queryKey: mailKey, queryFn: getMail });
  if (view.data === undefined) {
    return <LoadState error={view.error} onRetry={() => void view.refetch()} />;
  }
  return <MailCards view={view.data} />;
}

interface Draft {
  host: string;
  /** As typed; empty takes the usual port of the encryption. */
  port: string;
  security: MailSecurity;
  username: string;
  /** Empty keeps the stored password (same server and user). */
  password: string;
  fromName: string;
  fromAddress: string;
  replyTo: string;
}

const EMPTY: MailSettings = {
  host: "",
  port: 587,
  security: "starttls",
  username: "",
  fromName: "Kalzit",
  fromAddress: "",
  replyTo: "",
};

function toDraft(settings: MailSettings | null): Draft {
  const s = settings ?? EMPTY;
  return { ...s, port: s.port === 0 ? "" : String(s.port), password: "" };
}

function fromDraft(draft: Draft): MailSettings {
  const port = Number.parseInt(draft.port.trim(), 10);
  return {
    host: draft.host.trim(),
    port: Number.isFinite(port) && port > 0 && port < 65536 ? port : 0,
    security: draft.security,
    username: draft.username.trim(),
    fromName: draft.fromName.trim(),
    fromAddress: draft.fromAddress.trim(),
    replyTo: draft.replyTo.trim(),
  };
}

/** The fields whose values differ from the stored ones, in form order. */
const FIELDS: readonly (keyof MailSettings)[] = [
  "host",
  "port",
  "security",
  "username",
  "fromName",
  "fromAddress",
  "replyTo",
];

const FIELD_TEXT: Record<keyof MailSettings | "password", MessageKey> = {
  host: "settings.mail.host",
  port: "settings.mail.port",
  security: "settings.mail.security",
  username: "settings.mail.username",
  password: "settings.mail.password",
  fromName: "settings.mail.fromName",
  fromAddress: "settings.mail.fromAddress",
  replyTo: "settings.mail.replyTo",
};

interface Problem {
  field: MailField | undefined;
  text: string;
}

const ERROR_FIELDS: readonly MailField[] = [...FIELDS, "password", "to"];

function problemOf(t: Translate, error: unknown): Problem {
  const reason = errorReason(error);
  const text = (reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error);
  const field = isApiError(error) ? ERROR_FIELDS.find((f) => f === error.field) : undefined;
  return { field, text };
}

function MailCards({ view }: { view: MailView }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const me = useQuery(meQuery);
  const [version, setVersion] = useState(view.version);
  const [editing, setEditing] = useState(view.settings !== null);
  const [draft, setDraft] = useState(() => toDraft(view.settings));
  const [to, setTo] = useState(me.data?.email ?? "");
  const [problem, setProblem] = useState<Problem | null>(null);
  /** The values the last test mail went out with, and what the server said. */
  const [tested, setTested] = useState<{ settings: string; delivered: Delivered } | null>(null);
  const [removing, setRemoving] = useState(false);
  // Saved here or elsewhere: the form shows what is stored now.
  if (version !== view.version) {
    setVersion(view.version);
    setDraft(toDraft(view.settings));
    setEditing(view.settings !== null);
    setProblem(null);
    setTested(null);
  }
  const stored = toDraft(view.settings);
  const current = fromDraft(draft);
  const changed = FIELDS.filter(
    (field) => JSON.stringify(current[field]) !== JSON.stringify(fromDraft(stored)[field]),
  );
  const passwordChanged = draft.password !== "";
  const dirty = view.settings === null ? editing : changed.length > 0 || passwordChanged;
  const key = JSON.stringify({ ...current, password: draft.password });
  const testedNow = tested !== null && tested.settings === key;
  const locked = !view.editable;
  const lockNoticeId = useId();
  const password = passwordChanged ? draft.password : undefined;

  const save = useMutation({
    mutationFn: () => saveMail(current, password, view.version),
    onSuccess: (saved) => {
      queryClient.setQueryData(mailKey, saved);
      notice.show({ message: t("settings.mail.saved") });
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        void queryClient.invalidateQueries({ queryKey: mailKey });
        setProblem({ field: undefined, text: t("settings.mail.conflict") });
        return;
      }
      setProblem(problemOf(t, error));
    },
  });
  const remove = useMutation({
    mutationFn: () => saveMail(null, undefined, view.version),
    onSuccess: (saved) => {
      setRemoving(false);
      queryClient.setQueryData(mailKey, saved);
      notice.show({ message: t("settings.mail.removed") });
    },
  });
  const test = useMutation({
    mutationFn: () =>
      sendTestMail(locked ? null : current, locked ? undefined : password, to.trim()),
    onMutate: () => {
      setTested(null);
      setProblem(null);
    },
    onSuccess: (delivered) => setTested({ settings: key, delivered }),
    onError: (error) => setProblem(problemOf(t, error)),
  });
  const busy = save.isPending || test.isPending;

  function change(next: Partial<Draft>) {
    setDraft((now) => ({ ...now, ...next }));
    setProblem(null);
  }
  const errorFor = (field: MailField) => (problem?.field === field ? problem.text : undefined);

  if (!editing) {
    return (
      <>
        <PublicUrlNotice view={view} />
        <section className="settings-card mail-empty" aria-labelledby="mail-empty">
          <div className="settings-row">
            <div className="settings-row__text">
              <h3 className="settings-row__title" id="mail-empty">
                {t("settings.mail.noneTitle")}
              </h3>
              <p className="settings-row__description">{t("settings.mail.noneText")}</p>
            </div>
            <div className="settings-row__control">
              <button
                type="button"
                className="button button--primary"
                onClick={() => setEditing(true)}
              >
                {t("settings.mail.setUp")}
              </button>
            </div>
          </div>
        </section>
        <WhatIsSent />
      </>
    );
  }

  return (
    <>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <PublicUrlNotice view={view} />
      <form
        className="settings-card"
        aria-labelledby="mail-heading"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy && !locked && dirty && testedNow) {
            save.mutate();
          }
        }}
      >
        <div className="settings-card__heading">
          <h3 id="mail-heading">{t("settings.mail.title")}</h3>
          {locked ? (
            <span className="mail-source">
              {t(
                view.source === "environment"
                  ? "settings.mail.fromEnvironment"
                  : "settings.mail.fromFile",
              )}
            </span>
          ) : null}
        </div>
        {locked ? (
          <p className="notice mail-notice" id={lockNoticeId}>
            <Icon name="lock" />
            {t("settings.mail.locked")}
          </p>
        ) : null}
        <LockNotice.Provider value={locked ? lockNoticeId : undefined}>
          <Row
            id="mail.host"
            title={t("settings.mail.server")}
            description={t("settings.mail.serverHint")}
            error={errorFor("host") ?? errorFor("port")}
          >
            {(labelled) => (
              <div className="mail-pair">
                <input
                  className="input input--mono mail-field"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="smtp.example.com"
                  disabled={locked}
                  value={draft.host}
                  {...labelled}
                  onChange={(event) => change({ host: event.currentTarget.value })}
                />
                <input
                  className="input input--mono mail-port"
                  inputMode="numeric"
                  autoComplete="off"
                  placeholder={draft.security === "tls" ? "465" : "587"}
                  disabled={locked}
                  value={draft.port}
                  aria-label={t("settings.mail.port")}
                  aria-describedby={locked ? lockNoticeId : undefined}
                  aria-invalid={errorFor("port") === undefined ? undefined : true}
                  onChange={(event) => change({ port: event.currentTarget.value })}
                />
              </div>
            )}
          </Row>
          <Row
            id="mail.security"
            title={t("settings.mail.security")}
            description={t(
              draft.security === "tls"
                ? "settings.mail.tlsHint"
                : draft.security === "none"
                  ? "settings.mail.noneHint"
                  : "settings.mail.starttlsHint",
            )}
            error={errorFor("security")}
          >
            {(labelled) =>
              draft.security === "none" ? (
                <span className="mail-fixed" {...labelled}>
                  {t("settings.mail.unencrypted")}
                </span>
              ) : (
                <Segmented
                  labelled={labelled}
                  value={draft.security}
                  options={[
                    { value: "starttls", label: "STARTTLS" },
                    { value: "tls", label: "TLS" },
                  ]}
                  disabled={locked}
                  onChange={(value) => {
                    if (!locked) change({ security: value as MailSecurity });
                  }}
                />
              )
            }
          </Row>
          <Row
            id="mail.username"
            title={t("settings.mail.username")}
            description={t("settings.mail.usernameHint")}
            error={errorFor("username")}
          >
            {(labelled) => (
              <input
                className="input mail-field"
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                value={draft.username}
                {...labelled}
                onChange={(event) => change({ username: event.currentTarget.value })}
              />
            )}
          </Row>
          {locked ? null : (
            <Row
              id="mail.password"
              title={t("settings.mail.password")}
              description={
                view.hasPassword
                  ? t("settings.mail.passwordStored")
                  : t("settings.mail.passwordHint")
              }
              error={errorFor("password")}
            >
              {(labelled) => (
                <input
                  className="input mail-field"
                  type="password"
                  autoComplete="new-password"
                  placeholder={view.hasPassword ? "••••••••••••" : ""}
                  value={draft.password}
                  {...labelled}
                  onChange={(event) => change({ password: event.currentTarget.value })}
                />
              )}
            </Row>
          )}
          <Row
            id="mail.fromName"
            title={t("settings.mail.fromName")}
            description={t("settings.mail.fromNameHint")}
            error={errorFor("fromName")}
          >
            {(labelled) => (
              <input
                className="input mail-field"
                autoComplete="off"
                disabled={locked}
                value={draft.fromName}
                {...labelled}
                onChange={(event) => change({ fromName: event.currentTarget.value })}
              />
            )}
          </Row>
          <Row
            id="mail.fromAddress"
            title={t("settings.mail.fromAddress")}
            description={t("settings.mail.fromAddressHint")}
            error={errorFor("fromAddress")}
          >
            {(labelled) => (
              <input
                className="input mail-field"
                type="email"
                autoComplete="off"
                spellCheck={false}
                placeholder="kalzit@example.com"
                disabled={locked}
                value={draft.fromAddress}
                {...labelled}
                onChange={(event) => change({ fromAddress: event.currentTarget.value })}
              />
            )}
          </Row>
          <Row
            id="mail.replyTo"
            title={t("settings.mail.replyTo")}
            description={t("settings.mail.replyToHint")}
            error={errorFor("replyTo")}
          >
            {(labelled) => (
              <input
                className="input mail-field"
                type="email"
                autoComplete="off"
                spellCheck={false}
                disabled={locked}
                value={draft.replyTo}
                {...labelled}
                onChange={(event) => change({ replyTo: event.currentTarget.value })}
              />
            )}
          </Row>
          <Row
            id="mail.test"
            title={t("settings.mail.testTo")}
            description={t("settings.mail.testHint")}
            error={errorFor("to")}
          >
            {(labelled) => (
              <div className="mail-pair">
                <input
                  className="input mail-field"
                  type="email"
                  autoComplete="email"
                  spellCheck={false}
                  value={to}
                  {...labelled}
                  onChange={(event) => {
                    setTo(event.currentTarget.value);
                    setProblem(null);
                  }}
                />
                <button
                  type="button"
                  className="button button--secondary"
                  aria-disabled={busy}
                  onClick={() => {
                    if (!busy) test.mutate();
                  }}
                >
                  {test.isPending ? t("settings.mail.testing") : t("settings.mail.test")}
                </button>
              </div>
            )}
          </Row>
        </LockNotice.Provider>
        <div className="mail-footer">
          <div className="mail-footer__result" aria-live="polite">
            {problem === null ? null : (
              <p className="field__error">
                {problem.field === undefined ? problem.text : t("settings.mail.checkField")}
              </p>
            )}
            {tested !== null ? (
              <TestResult delivered={tested.delivered} security={current.security} />
            ) : null}
            {locked ? null : dirty ? (
              <p className="settings-hint">
                {changed.length === 0 && !passwordChanged
                  ? t("settings.mail.unsaved")
                  : t("settings.mail.changed", {
                      fields: [...changed, ...(passwordChanged ? ["password" as const] : [])]
                        .map((field) => t(FIELD_TEXT[field]))
                        .join(", "),
                    })}
                {testedNow ? null : ` ${t("settings.mail.testFirst")}`}
              </p>
            ) : null}
          </div>
          {locked ? null : (
            <div className="mail-footer__actions">
              {view.settings !== null && view.source === "database" ? (
                <button
                  type="button"
                  className="button button--ghost"
                  onClick={() => setRemoving(true)}
                >
                  {t("settings.mail.remove")}
                </button>
              ) : null}
              <button
                type="button"
                className="button button--secondary"
                disabled={!dirty}
                onClick={() => {
                  setDraft(toDraft(view.settings));
                  setEditing(view.settings !== null);
                  setProblem(null);
                  setTested(null);
                }}
              >
                {t("settings.mail.discard")}
              </button>
              <button
                type="submit"
                className="button button--primary"
                aria-disabled={busy || !dirty || !testedNow}
                disabled={!dirty}
              >
                {save.isPending ? t("settings.mail.saving") : t("settings.mail.save")}
              </button>
            </div>
          )}
        </div>
      </form>
      <WhatIsSent />
      <ConfirmDialog
        open={removing}
        title={t("settings.mail.removeTitle")}
        confirmLabel={t("settings.mail.removeConfirm")}
        busy={remove.isPending}
        error={remove.error === null ? null : errorText(t, remove.error)}
        onClose={() => setRemoving(false)}
        onConfirm={() => remove.mutate()}
      >
        {t("settings.mail.removeText")}
      </ConfirmDialog>
    </>
  );
}

function PublicUrlNotice({ view }: { view: MailView }) {
  const { t } = useI18n();
  if (view.publicUrl !== null) {
    return null;
  }
  return (
    <p className="notice mail-notice">
      <Icon name="alert" />
      {t("settings.mail.publicUrlMissing")}
    </p>
  );
}

function TestResult({ delivered, security }: { delivered: Delivered; security: MailSecurity }) {
  const { t, language, timeZone } = useI18n();
  const parts = [t("settings.mail.testReply", { reply: delivered.reply, ms: delivered.elapsedMs })];
  if (delivered.tls !== null) {
    parts.push(
      security === "starttls"
        ? t("settings.mail.testStarttls", { tls: delivered.tls })
        : t("settings.mail.testTls", { tls: delivered.tls }),
    );
  }
  if (delivered.certificateNotAfter !== null) {
    parts.push(
      t("settings.mail.testCertificate", {
        date: formatDateTime(delivered.certificateNotAfter, language, timeZone),
      }),
    );
  }
  return (
    <div className="mail-tested" role="status">
      <p className="mail-tested__line">
        <Icon name="check" />
        <span>
          <b>{t("settings.mail.testPassed")}</b> {parts.join(" · ")}
        </span>
      </p>
    </div>
  );
}

/** What goes out by mail (frame 6, right column). */
function WhatIsSent() {
  const { t } = useI18n();
  const items: [MessageKey, MessageKey][] = [
    ["settings.mail.sends.invitations", "settings.mail.sends.invitationsNote"],
    ["settings.mail.sends.reset", "settings.mail.sends.resetNote"],
    ["settings.mail.sends.tests", "settings.mail.sends.testsNote"],
  ];
  return (
    <section className="settings-card" aria-labelledby="mail-sends">
      <div className="settings-card__heading">
        <h3 id="mail-sends">{t("settings.mail.sends.title")}</h3>
      </div>
      <dl className="mail-sends">
        {items.map(([title, note]) => (
          <div key={title} className="mail-sends__item">
            <dt>{t(title)}</dt>
            <dd>{t(note)}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** The id of the section's lock notice while the values come from kalzit.toml or the environment. */
const LockNotice = createContext<string | undefined>(undefined);

/**
 * One field: its own ids for the label, description and error, handed to the control; a locked
 * form's notice describes every control too.
 */
function Row({
  id,
  title,
  description,
  error,
  children,
}: {
  id: string;
  title: string;
  description: ReactNode;
  error: string | undefined;
  children: (labelled: {
    "aria-labelledby": string;
    "aria-describedby": string;
    "aria-invalid"?: true;
  }) => ReactNode;
}) {
  const titleId = useId();
  const errorId = `${titleId}-error`;
  const lockId = useContext(LockNotice);
  const labelled = {
    "aria-labelledby": titleId,
    "aria-describedby": [
      error === undefined ? undefined : errorId,
      `${titleId}-description`,
      lockId,
    ]
      .filter((id) => id !== undefined)
      .join(" "),
    ...(error === undefined ? {} : { "aria-invalid": true as const }),
  };
  return (
    <RowFrame
      id={id}
      title={title}
      titleId={titleId}
      description={description}
      error={error}
      errorId={errorId}
      found={false}
    >
      {children(labelled)}
    </RowFrame>
  );
}
