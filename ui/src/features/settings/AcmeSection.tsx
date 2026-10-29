import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Icon } from "../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { formatDateTime } from "../admin/components/format";
import { useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import { errorReason, reasonText } from "../datasources/reasons";
import {
  type AcmeChallenge,
  type AcmeChecked,
  type AcmeDirectory,
  type AcmeField,
  type AcmeProblem,
  type AcmeSettings,
  type AcmeView,
  acmeKey,
  getAcme,
  renewAcme,
  saveAcme,
  testAcme,
} from "./acmeApi";
import { RowFrame, Segmented } from "./rows";
import "./settings.css";
import "./acme.css";

/**
 * Automatic certificates over ACME, below the network rows of "Network, HTTPS and proxy": the
 * certificate in use with its renewal, then the settings. They depend on each other (a directory
 * and its CA, names and a challenge the listeners can answer), so they apply with one explicit
 * Save after the server's check, which names the field of the first problem; "Test connection"
 * runs the same check without saving.
 */
export function AcmeSection() {
  const view = useQuery({
    queryKey: acmeKey,
    queryFn: getAcme,
    // While an order runs, the status follows it.
    refetchInterval: (query) => (query.state.data?.status.phase === "working" ? 2000 : false),
  });
  if (view.data === undefined) {
    return <LoadState error={view.error} onRetry={() => void view.refetch()} />;
  }
  return <AcmeCards view={view.data} />;
}

interface Draft {
  enabled: boolean;
  directory: AcmeDirectory;
  directoryUrl: string;
  directoryCa: string;
  /** One name per line, as typed. */
  domains: string;
  email: string;
  challenge: AcmeChallenge;
  acceptTerms: boolean;
}

function toDraft(settings: AcmeSettings): Draft {
  return { ...settings, domains: settings.domains.join("\n") };
}

function fromDraft(draft: Draft): AcmeSettings {
  return {
    ...draft,
    domains: draft.domains
      .split(/[\s,]+/)
      .map((d) => d.trim())
      .filter((d) => d !== ""),
  };
}

function same(a: Draft, b: Draft): boolean {
  return JSON.stringify(fromDraft(a)) === JSON.stringify(fromDraft(b));
}

interface Problem {
  field: AcmeField | undefined;
  text: string;
}

const FIELDS: readonly AcmeField[] = [
  "enabled",
  "directory",
  "directoryUrl",
  "directoryCa",
  "domains",
  "email",
  "challenge",
  "acceptTerms",
];

function problemOf(t: Translate, error: unknown): Problem {
  const reason = errorReason(error);
  const text = (reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error);
  const field = isApiError(error) ? FIELDS.find((f) => f === error.field) : undefined;
  return { field, text };
}

function warningText(t: Translate, warning: AcmeProblem): string {
  return (
    reasonText(t, { reason: warning.reason, params: warning.params, fallback: warning.message }) ??
    warning.message
  );
}

function AcmeCards({ view }: { view: AcmeView }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [version, setVersion] = useState(view.version);
  const [draft, setDraft] = useState(() => toDraft(view.settings));
  const [problem, setProblem] = useState<Problem | null>(null);
  const [checked, setChecked] = useState<AcmeChecked | null>(null);
  // Saved here or elsewhere: the form shows what is stored now.
  if (version !== view.version) {
    setVersion(view.version);
    setDraft(toDraft(view.settings));
    setProblem(null);
  }
  const dirty = !same(draft, toDraft(view.settings));

  const save = useMutation({
    mutationFn: () => saveAcme(fromDraft(draft), view.version),
    onSuccess: (saved) => {
      queryClient.setQueryData(acmeKey, saved);
      setProblem(null);
      notice.show({ message: t("settings.acme.saved") });
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict")) {
        // Another administrator saved meanwhile; their values replace the form.
        void queryClient.invalidateQueries({ queryKey: acmeKey });
        setProblem({ field: undefined, text: t("settings.acme.conflict") });
        return;
      }
      setProblem(problemOf(t, error));
    },
  });
  const test = useMutation({
    mutationFn: () => testAcme(fromDraft(draft)),
    onMutate: () => {
      setChecked(null);
      setProblem(null);
    },
    onSuccess: setChecked,
    onError: (error) => setProblem(problemOf(t, error)),
  });
  const renew = useMutation({
    mutationFn: renewAcme,
    onSuccess: (next) => queryClient.setQueryData(acmeKey, next),
    onError: (error) => notice.showError(problemOf(t, error).text),
  });
  const busy = save.isPending || test.isPending;

  function change(next: Partial<Draft>) {
    setDraft((current) => ({ ...current, ...next }));
    setChecked(null);
  }
  const errorFor = (field: AcmeField) => (problem?.field === field ? problem.text : undefined);
  const http = view.server.httpAddr ?? t("settings.acme.listenerOff");
  const https = view.server.httpsAddr ?? t("settings.acme.listenerOff");

  return (
    <>
      <StatusCard view={view} onRenew={() => renew.mutate()} renewing={renew.isPending} />
      <form
        className="settings-card"
        aria-labelledby="acme-heading"
        onSubmit={(event) => {
          event.preventDefault();
          if (!busy) {
            save.mutate();
          }
        }}
      >
        <div className="settings-card__heading">
          <h3 id="acme-heading">{t("settings.acme.title")}</h3>
        </div>
        {view.server.certificateFiles ? (
          <p className="notice acme-notice">
            <Icon name="lock" />
            {t("settings.acme.certificateFiles")}
          </p>
        ) : view.server.httpsAddr === null ? (
          <p className="notice acme-notice">
            <Icon name="alert" />
            {t("settings.acme.httpsOff")}
          </p>
        ) : null}
        <Row
          id="acme.enabled"
          title={t("settings.acme.enabled.label")}
          description={t("settings.acme.enabled.description")}
          error={errorFor("enabled")}
        >
          {(labelled) => (
            <input
              type="checkbox"
              role="switch"
              className="settings-switch"
              checked={draft.enabled}
              aria-checked={draft.enabled}
              {...labelled}
              onChange={(event) => change({ enabled: event.currentTarget.checked })}
            />
          )}
        </Row>
        <Row
          id="acme.directory"
          title={t("settings.acme.directory.label")}
          description={t(DIRECTORY_HINT[draft.directory])}
          error={errorFor("directory")}
        >
          {(labelled) => (
            <Segmented
              labelled={labelled}
              value={draft.directory}
              options={(["letsencrypt", "letsencrypt_staging", "custom"] as const).map((value) => ({
                value,
                label: t(DIRECTORY_LABEL[value]),
              }))}
              onChange={(value) => change({ directory: value as AcmeDirectory })}
            />
          )}
        </Row>
        {draft.directory === "custom" ? (
          <>
            <Row
              id="acme.directoryUrl"
              title={t("settings.acme.directoryUrl.label")}
              description={t("settings.acme.directoryUrl.description")}
              error={errorFor("directoryUrl")}
            >
              {(labelled) => (
                <input
                  className="input input--mono acme-field"
                  type="url"
                  inputMode="url"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="https://ca.example.com/acme/directory"
                  value={draft.directoryUrl}
                  {...labelled}
                  onChange={(event) => change({ directoryUrl: event.currentTarget.value })}
                />
              )}
            </Row>
            <Row
              id="acme.directoryCa"
              title={t("settings.acme.directoryCa.label")}
              description={t("settings.acme.directoryCa.description")}
              error={errorFor("directoryCa")}
            >
              {(labelled) => (
                <textarea
                  className="input input--mono acme-field acme-field--tall"
                  rows={4}
                  spellCheck={false}
                  placeholder="-----BEGIN CERTIFICATE-----"
                  value={draft.directoryCa}
                  {...labelled}
                  onChange={(event) => change({ directoryCa: event.currentTarget.value })}
                />
              )}
            </Row>
          </>
        ) : null}
        <Row
          id="acme.domains"
          title={t("settings.acme.domains.label")}
          description={t("settings.acme.domains.description")}
          error={errorFor("domains")}
        >
          {(labelled) => (
            <textarea
              className="input input--mono acme-field"
              rows={3}
              spellCheck={false}
              placeholder="kalzit.example.com"
              value={draft.domains}
              {...labelled}
              onChange={(event) => change({ domains: event.currentTarget.value })}
            />
          )}
        </Row>
        <Row
          id="acme.email"
          title={t("settings.acme.email.label")}
          description={t("settings.acme.email.description")}
          error={errorFor("email")}
        >
          {(labelled) => (
            <input
              className="input acme-field"
              type="email"
              autoComplete="email"
              placeholder="ops@example.com"
              value={draft.email}
              {...labelled}
              onChange={(event) => change({ email: event.currentTarget.value })}
            />
          )}
        </Row>
        <Row
          id="acme.challenge"
          title={t("settings.acme.challenge.label")}
          description={
            draft.challenge === "http-01"
              ? t("settings.acme.challenge.http", { address: http })
              : t("settings.acme.challenge.alpn", { address: https })
          }
          error={errorFor("challenge")}
        >
          {(labelled) => (
            <Segmented
              labelled={labelled}
              value={draft.challenge}
              options={[
                { value: "http-01", label: "HTTP-01" },
                { value: "tls-alpn-01", label: "TLS-ALPN-01" },
              ]}
              onChange={(value) => change({ challenge: value as AcmeChallenge })}
            />
          )}
        </Row>
        <Row
          id="acme.acceptTerms"
          title={t("settings.acme.terms.label")}
          description={
            checked?.termsOfService ? (
              <a href={checked.termsOfService} target="_blank" rel="noreferrer noopener">
                {t("settings.acme.terms.read")}
              </a>
            ) : (
              t("settings.acme.terms.description")
            )
          }
          error={errorFor("acceptTerms")}
        >
          {(labelled) => (
            <input
              type="checkbox"
              className="settings-switch"
              checked={draft.acceptTerms}
              {...labelled}
              onChange={(event) => change({ acceptTerms: event.currentTarget.checked })}
            />
          )}
        </Row>
        <div className="acme-footer">
          <div className="acme-footer__result" aria-live="polite">
            {problem !== null && problem.field === undefined ? (
              <p className="field__error">{problem.text}</p>
            ) : null}
            {checked !== null ? <Checked checked={checked} /> : null}
            {dirty && problem === null && checked === null ? (
              <p className="settings-hint">{t("settings.acme.unsaved")}</p>
            ) : null}
          </div>
          <div className="acme-footer__actions">
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) {
                  test.mutate();
                }
              }}
            >
              {test.isPending ? t("settings.acme.testing") : t("settings.acme.test")}
            </button>
            <button
              type="submit"
              className="button button--primary"
              aria-disabled={busy || !dirty}
              disabled={!dirty}
            >
              {save.isPending ? t("settings.acme.saving") : t("settings.acme.save")}
            </button>
          </div>
        </div>
      </form>
    </>
  );
}

const DIRECTORY_LABEL: Record<AcmeDirectory, MessageKey> = {
  letsencrypt: "settings.acme.directory.letsencrypt",
  letsencrypt_staging: "settings.acme.directory.staging",
  custom: "settings.acme.directory.custom",
};

const DIRECTORY_HINT: Record<AcmeDirectory, MessageKey> = {
  letsencrypt: "settings.acme.directory.letsencryptHint",
  letsencrypt_staging: "settings.acme.directory.stagingHint",
  custom: "settings.acme.directory.customHint",
};

/** One field: its own ids for the label, description and error, handed to the control. */
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
  const labelled = {
    "aria-labelledby": titleId,
    "aria-describedby":
      error === undefined ? `${titleId}-description` : `${errorId} ${titleId}-description`,
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

function Checked({ checked }: { checked: AcmeChecked }) {
  const { t } = useI18n();
  return (
    <div className="acme-checked" role="status">
      <p className="acme-checked__line">
        <Icon name="check" />
        {t("settings.acme.testPassed")}
      </p>
      {checked.warnings.map((warning) => (
        <p key={warning.reason} className="acme-checked__line acme-checked__line--warning">
          <Icon name="alert" />
          {warningText(t, warning)}
        </p>
      ))}
    </div>
  );
}

const PHASE_TEXT: Record<AcmeView["status"]["phase"], MessageKey> = {
  off: "settings.acme.phase.off",
  waiting: "settings.acme.phase.waiting",
  working: "settings.acme.phase.working",
  valid: "settings.acme.phase.valid",
  failed: "settings.acme.phase.failed",
};

function StatusCard({
  view,
  onRenew,
  renewing,
}: {
  view: AcmeView;
  onRenew: () => void;
  renewing: boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const titleId = useId();
  const when = (ms: number) => formatDateTime(ms, language, timeZone);
  const { status } = view;
  const certificate = status.certificate;
  const error = status.lastError;
  return (
    <section className="settings-card" aria-labelledby={titleId}>
      <div className="settings-row acme-status">
        <div className="settings-row__text">
          <h3 className="settings-row__title" id={titleId}>
            {t("settings.acme.status.title")}
          </h3>
          <p className={`acme-phase acme-phase--${status.phase}`}>{t(PHASE_TEXT[status.phase])}</p>
          {certificate === null ? (
            <p className="settings-row__description">{t("settings.acme.status.none")}</p>
          ) : (
            <dl className="acme-facts">
              <dt>{t("settings.acme.status.names")}</dt>
              <dd className="acme-facts__code">{certificate.domains.join(", ")}</dd>
              <dt>{t("settings.acme.status.issuer")}</dt>
              <dd>{certificate.issuer}</dd>
              <dt>{t("settings.acme.status.validUntil")}</dt>
              <dd>{when(certificate.notAfter)}</dd>
              <dt>{t("settings.acme.status.renewFrom")}</dt>
              <dd>{when(certificate.renewAt)}</dd>
            </dl>
          )}
          {status.storeError === null ? null : (
            <p className="field__error">
              {t("settings.acme.status.storeError", { reason: warningText(t, status.storeError) })}
            </p>
          )}
          {error === null ? null : (
            <p className="field__error">
              {t("settings.acme.status.lastError", {
                when: when(error.at),
                reason: warningText(t, error),
              })}
              {status.nextAttemptAt === null
                ? null
                : ` ${t("settings.acme.status.nextAttempt", { when: when(status.nextAttemptAt) })}`}
            </p>
          )}
        </div>
        <div className="settings-row__control">
          {view.settings.enabled ? (
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={renewing || status.phase === "working"}
              onClick={() => {
                if (!renewing && status.phase !== "working") {
                  onRenew();
                }
              }}
            >
              <Icon name="refresh" />
              {t("settings.acme.renew")}
            </button>
          ) : null}
        </div>
      </div>
    </section>
  );
}
