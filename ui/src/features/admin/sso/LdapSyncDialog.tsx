import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Icon } from "../../../components/Icon";
import { type MessageKey, type Translate, useI18n } from "../../../i18n/i18n";
import { fetchSecurity, securityKeys } from "../../security/api";
import { ConfirmFactorDialog, methodsOf } from "../../security/ConfirmFactorDialog";
import { Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { useNotice } from "../components/Notice";
import { LoadState } from "../components/Section";
import {
  applySyncRun,
  fetchSync,
  fetchSyncRun,
  runSync,
  type SyncPerson,
  type SyncRun,
  type SyncState,
  ssoKeys,
} from "./api";
import { ssoErrorText } from "./texts";
import "../../datasources/datasources.css";
import "../../settings/settings.css";
import "./sso.css";

/** Status dot and word of a run; never colour alone. */
const RUN_STATUS: Record<SyncRun["status"], { dot: string; key: MessageKey }> = {
  running: { dot: "testing", key: "sso.sync.status.running" },
  done: { dot: "connected", key: "sso.sync.status.done" },
  halted: { dot: "slow", key: "sso.sync.status.halted" },
  failed: { dot: "unreachable", key: "sso.sync.status.failed" },
  applied: { dot: "connected", key: "sso.sync.status.applied" },
};

const REASONS: Record<string, MessageKey> = {
  not_in_directory: "sso.sync.reason.not_in_directory",
  disabled_in_directory: "sso.sync.reason.disabled_in_directory",
  no_mapped_group: "sso.sync.reason.no_mapped_group",
};

export function syncReasonText(t: Translate, reason: string): string {
  const key = REASONS[reason];
  return key === undefined ? reason : t(key);
}

function seconds(run: SyncRun): string {
  return run.finishedAt === null
    ? "–"
    : `${Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000))} s`;
}

function scheduleText(t: Translate, sync: SyncState): string {
  if (sync.schedule === "off") {
    return t("sso.sync.scheduleOff");
  }
  if (sync.schedule === "every6h") {
    return t("sso.sync.scheduleEvery6h");
  }
  return t("sso.sync.scheduleDaily", { hour: String(sync.hour).padStart(2, "0") });
}

/**
 * The sync of an LDAP provider (board frame 9): the last and next run, the runs with their result,
 * a halted run's list with "Apply anyway" (a fresh second factor), and the accounts the sync
 * disabled. A sync never deletes an account.
 */
export function LdapSyncDialog({
  providerId,
  name,
  onClose,
}: {
  providerId: string;
  name: string;
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const sync = useQuery({
    queryKey: ssoKeys.sync(providerId),
    queryFn: () => fetchSync(providerId),
  });
  const [reviewing, setReviewing] = useState<string | null>(null);
  const time = (ms: number) => formatDateTime(ms, language, timeZone);

  const now = useMutation({
    mutationFn: () => runSync(providerId),
    onSuccess: (run) => {
      void queryClient.invalidateQueries({ queryKey: ssoKeys.all });
      notice.show({ message: runMessage(t, run) });
    },
    onError: (error) => notice.showError(ssoErrorText(t, error)),
  });

  const data = sync.data;
  const last = data?.runs[0];
  return (
    <>
      <Dialog
        open
        wide
        title={t("sso.sync.title", { name })}
        onClose={onClose}
        footer={
          <div className="sso-dialog__footer">
            <span className="sso-dialog__spacer" />
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t("sso.sync.close")}
            </button>
          </div>
        }
      >
        {data === undefined ? (
          <LoadState error={sync.error} onRetry={() => void sync.refetch()} />
        ) : (
          <div className="sso-stack">
            <div className="sso-sync__head">
              <p className="sso-muted sso-small">
                {scheduleText(t, data)} ·{" "}
                {t("sso.sync.thresholdLine", { threshold: data.threshold })}
              </p>
              <button
                type="button"
                className="button button--secondary"
                aria-disabled={now.isPending}
                onClick={() => {
                  if (!now.isPending) {
                    now.mutate();
                  }
                }}
              >
                <Icon name="refresh" />
                {now.isPending ? t("sso.sync.running") : t("sso.sync.now")}
              </button>
            </div>
            <dl className="sso-strip">
              <div className="sso-strip__cell">
                <dt className="sso-strip__label">{t("sso.sync.lastRun")}</dt>
                <dd className="sso-strip__value">
                  {last === undefined ? t("sso.sync.never") : time(last.startedAt)}
                </dd>
                <dd className="sso-strip__sub">
                  {last === undefined
                    ? "–"
                    : `${seconds(last)} · ${t(RUN_STATUS[last.status].key)}`}
                </dd>
              </div>
              <div className="sso-strip__cell">
                <dt className="sso-strip__label">{t("sso.sync.checked")}</dt>
                <dd className="sso-strip__value">{last?.checked ?? "–"}</dd>
                <dd className="sso-strip__sub">{t("sso.sync.checkedSub")}</dd>
              </div>
              <div className="sso-strip__cell">
                <dt className="sso-strip__label">{t("sso.sync.deactivated")}</dt>
                <dd className="sso-strip__value">{last?.deactivated ?? "–"}</dd>
                <dd className="sso-strip__sub">{t("sso.sync.deactivatedSub")}</dd>
              </div>
              <div className="sso-strip__cell">
                <dt className="sso-strip__label">{t("sso.sync.nextRun")}</dt>
                <dd className="sso-strip__value">
                  {data.nextRunAt === null ? t("sso.sync.noNext") : time(data.nextRunAt)}
                </dd>
                <dd className="sso-strip__sub">{scheduleText(t, data)}</dd>
              </div>
            </dl>
            {data.failuresInRow >= 3 ? (
              <p className="sso-alarm">
                <Icon name="alert" />
                <span>{t("sso.sync.failuresInRow", { count: data.failuresInRow })}</span>
              </p>
            ) : null}
            <RunsTable
              t={t}
              runs={data.runs}
              time={time}
              onReview={(runId) => setReviewing(runId)}
            />
            <DeactivatedTable t={t} sync={data} time={time} />
            <p className="settings-hint">{t("sso.sync.note")}</p>
          </div>
        )}
      </Dialog>
      {reviewing === null ? null : (
        <ReviewDialog
          providerId={providerId}
          runId={reviewing}
          onClose={() => setReviewing(null)}
          onApplied={(run) => {
            setReviewing(null);
            void queryClient.invalidateQueries({ queryKey: ssoKeys.all });
            notice.show({ message: runMessage(t, run) });
          }}
        />
      )}
    </>
  );
}

function runMessage(t: Translate, run: SyncRun): string {
  if (run.status === "halted") {
    return t("sso.sync.haltedNotice", {
      count: run.wouldDeactivate,
      accounts: run.accounts,
      threshold: run.threshold,
    });
  }
  if (run.status === "failed") {
    return t("sso.sync.failedNotice");
  }
  return t("sso.sync.doneNotice", {
    checked: run.checked,
    changed: run.changed,
    deactivated: run.deactivated,
  });
}

function RunsTable({
  t,
  runs,
  time,
  onReview,
}: {
  t: Translate;
  runs: SyncRun[];
  time: (ms: number) => string;
  onReview: (runId: string) => void;
}) {
  if (runs.length === 0) {
    return <p className="sso-note">{t("sso.sync.noRuns")}</p>;
  }
  return (
    <div className="settings-card">
      <div className="sso-table-wrap">
        <table className="sso-table" aria-label={t("sso.sync.runs")}>
          <thead>
            <tr>
              <th scope="col">{t("sso.sync.col.start")}</th>
              <th scope="col" className="sso-table__number">
                {t("sso.sync.col.duration")}
              </th>
              <th scope="col" className="sso-table__number">
                {t("sso.sync.col.checked")}
              </th>
              <th scope="col" className="sso-table__number">
                {t("sso.sync.col.changed")}
              </th>
              <th scope="col" className="sso-table__number">
                {t("sso.sync.col.deactivated")}
              </th>
              <th scope="col">{t("sso.sync.col.result")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("sso.providers.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {runs.map((run) => {
              const status = RUN_STATUS[run.status];
              return (
                <tr key={run.id}>
                  <td>{time(run.startedAt)}</td>
                  <td className="sso-table__number">{seconds(run)}</td>
                  <td className="sso-table__number">
                    {run.status === "failed" ? "–" : run.checked}
                  </td>
                  <td className="sso-table__number">{run.changed}</td>
                  <td className="sso-table__number">{run.deactivated}</td>
                  <td>
                    <span className="sso-status">
                      <span className="ds-status" data-status={status.dot}>
                        <span className="ds-status__dot" aria-hidden="true" />
                        <span>{t(status.key)}</span>
                      </span>
                      {run.status === "halted" ? (
                        <span className="sso-muted sso-small">
                          {t("sso.sync.haltedDetail", {
                            count: run.wouldDeactivate,
                            accounts: run.accounts,
                            percent: Math.round(
                              (100 * run.wouldDeactivate) / Math.max(1, run.accounts),
                            ),
                            threshold: run.threshold,
                          })}
                        </span>
                      ) : run.status === "failed" && run.error !== null ? (
                        <span className="sso-muted sso-small">
                          {t("sso.sync.failedDetail", { error: run.error })}
                        </span>
                      ) : null}
                    </span>
                  </td>
                  <td className="sso-table__actions">
                    {run.status === "halted" ? (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => onReview(run.id)}
                      >
                        {t("sso.sync.review")}
                      </button>
                    ) : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function DeactivatedTable({
  t,
  sync,
  time,
}: {
  t: Translate;
  sync: SyncState;
  time: (ms: number) => string;
}) {
  return (
    <section className="sso-stack" aria-labelledby="sso-sync-deactivated">
      <h3 className="settings-row__title" id="sso-sync-deactivated">
        {t("sso.sync.deactivatedTitle", { count: sync.deactivated.length })}
      </h3>
      <p className="settings-hint">{t("sso.sync.deactivatedHint")}</p>
      {sync.deactivated.length === 0 ? null : (
        <div className="settings-card">
          <div className="sso-table-wrap">
            <PeopleTable
              t={t}
              people={sync.deactivated}
              label={t("sso.sync.deactivatedTitle", { count: sync.deactivated.length })}
              at={(person) => time(person.at)}
            />
          </div>
        </div>
      )}
    </section>
  );
}

function PeopleTable<P extends SyncPerson>({
  t,
  people,
  label,
  at,
}: {
  t: Translate;
  people: P[];
  label: string;
  at?: (person: P) => string;
}) {
  return (
    <table className="sso-table" aria-label={label}>
      <thead>
        <tr>
          <th scope="col">{t("sso.sync.col.person")}</th>
          <th scope="col">{t("sso.sync.col.login")}</th>
          {at === undefined ? null : <th scope="col">{t("sso.sync.col.at")}</th>}
          <th scope="col">{t("sso.sync.col.reason")}</th>
        </tr>
      </thead>
      <tbody>
        {people.map((person) => (
          <tr key={person.userId}>
            <td>
              <span className="sso-provider__text">
                <span className="sso-provider__name">{person.name}</span>
                <span className="sso-muted sso-small">{person.email}</span>
              </span>
            </td>
            <td className="sso-mono">{person.login ?? "–"}</td>
            {at === undefined ? null : <td>{at(person)}</td>}
            <td>{syncReasonText(t, person.reason)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/** A halted run: the accounts it would disable, and "Apply anyway" with a fresh second factor. */
function ReviewDialog({
  providerId,
  runId,
  onClose,
  onApplied,
}: {
  providerId: string;
  runId: string;
  onClose: () => void;
  onApplied: (run: SyncRun) => void;
}) {
  const { t } = useI18n();
  const run = useQuery({
    queryKey: ssoKeys.syncRun(providerId, runId),
    queryFn: () => fetchSyncRun(providerId, runId),
  });
  const security = useQuery({ queryKey: securityKeys.status, queryFn: fetchSecurity });
  const [confirming, setConfirming] = useState(false);
  const data = run.data;
  const methods = security.data === undefined ? [] : methodsOf(security.data);
  const noFactor = security.data !== undefined && methods.length === 0;

  if (confirming && security.data !== undefined && data !== undefined) {
    return (
      <ConfirmFactorDialog
        open
        title={t("sso.sync.applyTitle")}
        confirmLabel={t("sso.sync.applyConfirm", { count: data.pending.length })}
        status={security.data}
        onClose={() => setConfirming(false)}
        describeError={(failure) => ssoErrorText(t, failure)}
        action={async () => {
          const applied = await applySyncRun(providerId, runId);
          onApplied(applied);
        }}
      >
        {t("sso.sync.applyText", { count: data.pending.length })}
      </ConfirmFactorDialog>
    );
  }

  return (
    <Dialog
      open
      wide
      title={t("sso.sync.reviewTitle")}
      onClose={onClose}
      footer={
        <div className="sso-dialog__footer">
          <span className="sso-dialog__spacer" />
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          {data?.status === "halted" ? (
            <button
              type="button"
              className="button button--danger"
              aria-disabled={noFactor || security.data === undefined}
              aria-describedby={noFactor ? "sso-sync-no-factor" : undefined}
              onClick={() => {
                if (!noFactor && security.data !== undefined) {
                  setConfirming(true);
                }
              }}
            >
              {t("sso.sync.apply")}
            </button>
          ) : null}
        </div>
      }
    >
      {data === undefined ? (
        <LoadState error={run.error} onRetry={() => void run.refetch()} />
      ) : (
        <div className="sso-stack">
          <p className="admin-dialog__text">
            {t("sso.sync.reviewText", {
              count: data.wouldDeactivate,
              accounts: data.accounts,
              threshold: data.threshold,
            })}
          </p>
          {noFactor ? (
            <p className="sso-alarm" id="sso-sync-no-factor">
              <Icon name="alert" />
              <span>{t("datasources.reason.ldap.sync_needs_second_factor")}</span>
            </p>
          ) : null}
          <div className="settings-card">
            <div className="sso-table-wrap">
              <PeopleTable t={t} people={data.pending} label={t("sso.sync.pending")} />
            </div>
          </div>
        </div>
      )}
    </Dialog>
  );
}
