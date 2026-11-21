import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FigureTile, FigureTiles } from "../../components/FigureTile";
import { Icon } from "../../components/Icon";
import { STACK_ROLES } from "../../components/stackTable";
import { GUIDE_URL } from "../../help/docs";
import { hasMessage, type MessageKey, type Translate, useI18n } from "../../i18n/i18n";
import { formatBytes } from "../../lib/bytes";
import { adminKeys } from "../admin/api";
import { ConfirmDialog } from "../admin/components/Dialog";
import { formatDateTime } from "../admin/components/format";
import { Notice, useNotice } from "../admin/components/Notice";
import { LoadState } from "../admin/components/Section";
import { errorText } from "../admin/errors";
import { errorReason, reasonText } from "../datasources/reasons";
import {
  type BackupField,
  type BackupRun,
  type BackupsView,
  type BackupTarget,
  backupRunsKey,
  backupsKey,
  getBackups,
  listBackupRuns,
  runBackup,
  saveBackupTarget,
  testBackupTarget,
} from "./backupsApi";
import { RowFrame } from "./rows";
import { SectionActions } from "./SectionActions";
import { PlainRow, RowsConflict, useServerRows } from "./serverRows";
import "../dashboards/ui/shared.css";

/**
 * Verwaltung > Sicherungen (board Settings075.dc.html, frames 6 and 7): Kalzit backs up its own
 * database and the files a restore needs. Schedule, retention and encryption apply at once, with
 * undo; the target is a form of its own with a connection test and one explicit Save. Restoring
 * is done on the command line only, so the page links the guide.
 */
export function BackupsSection() {
  const view = useQuery({ queryKey: backupsKey, queryFn: getBackups });
  if (view.data === undefined) {
    return <LoadState error={view.error} onRetry={() => void view.refetch()} />;
  }
  return <Backups view={view.data} />;
}

/** A backup reason (`backup.bucket_not_found`) in the area's words, if it has any. */
function backupReason(t: Translate, reason: string | undefined): string | undefined {
  const key = `serverAdmin.backup.reason.${(reason ?? "").replace(/^backup\./, "")}`;
  return hasMessage(key) ? t(key) : undefined;
}

function failureText(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  return (
    backupReason(t, reason?.reason) ??
    (reason === undefined ? undefined : reasonText(t, reason)) ??
    errorText(t, error)
  );
}

/** A run's reason in the UI's words, with the server's detail when it gave one. */
function runProblem(t: Translate, run: BackupRun): string {
  const text =
    run.reason === null ? null : (backupReason(t, run.reason) ?? run.detail ?? run.reason);
  return [text, text === run.detail ? null : run.detail].filter((part) => part !== null).join(" ");
}

function seconds(run: BackupRun, language: string): string {
  if (run.finishedAt === null) return "–";
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: "second",
    maximumFractionDigits: 0,
  }).format(Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000)));
}

const targetLabel = (target: BackupTarget): string =>
  target.kind === "local" ? target.path : `S3: ${target.bucket}`;

/** Where an S3 target lies: its endpoint, region and prefix on one line. */
const s3Place = (target: Extract<BackupTarget, { kind: "s3" }>): string =>
  [target.endpoint, target.region, target.prefix].filter((part) => part !== "").join(" · ");

function Backups({ view }: { view: BackupsView }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const { settings, changes, byKey } = useServerRows();
  const runs = useQuery({ queryKey: backupRunsKey, queryFn: listBackupRuns });
  const [editing, setEditing] = useState(false);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: backupsKey });
  };
  const now = useMutation({
    mutationFn: runBackup,
    onSuccess: async (run) => {
      await refresh();
      if (run?.status === "failed") {
        notice.showError(runProblem(t, run));
      } else {
        notice.show({ message: t("serverAdmin.backup.done") });
      }
    },
    onError: (error) => notice.showError(failureText(t, error)),
  });
  // The schedule's facts follow the settings: a change of the interval moves the next run.
  const settingsAt = settings.dataUpdatedAt;
  const [seenAt, setSeenAt] = useState(settingsAt);
  if (seenAt !== settingsAt) {
    setSeenAt(settingsAt);
    void queryClient.invalidateQueries({ queryKey: backupsKey, exact: true });
  }
  const last = view.lastRun;
  const { target, schedule } = view;
  return (
    <div className="s75-wrap">
      <SectionActions>
        <a
          className="button button--secondary"
          href={`${GUIDE_URL}backup.md`}
          target="_blank"
          rel="noreferrer"
        >
          {t("serverAdmin.backup.guide")}
        </a>
        {target === null || editing ? null : (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setEditing(true)}
          >
            {t("serverAdmin.backup.edit")}
          </button>
        )}
        {/* One filled button per view: while the target is set up or edited, that is its own. */}
        <button
          type="button"
          className={
            target === null || editing ? "button button--secondary" : "button button--primary"
          }
          disabled={target === null || now.isPending}
          onClick={() => now.mutate()}
        >
          {now.isPending ? t("serverAdmin.backup.running") : t("admin.updates.backups.now")}
        </button>
      </SectionActions>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <FigureTiles>
        <FigureTile
          small
          label={t("serverAdmin.backup.last")}
          value={last === null ? "–" : formatDateTime(last.startedAt, language, timeZone)}
          note={
            last === null ? undefined : last.status === "failed" ? (
              <span className="s75-danger">{runProblem(t, last)}</span>
            ) : last.status === "running" ? (
              t("serverAdmin.backup.running")
            ) : (
              [
                t("admin.updates.history.installed"),
                last.sizeBytes === null ? null : formatBytes(last.sizeBytes, language),
                seconds(last, language),
              ]
                .filter((part) => part !== null)
                .join(" · ")
            )
          }
        />
        <FigureTile
          small
          label={t("serverAdmin.backup.next")}
          value={
            schedule.enabled && schedule.nextRunAt !== null && target !== null
              ? formatDateTime(schedule.nextRunAt, language, timeZone)
              : t("settings.off")
          }
          note={t("serverAdmin.backup.every", { hours: schedule.intervalHours })}
        />
        <FigureTile
          small
          label={t("serverAdmin.backup.target")}
          value={target === null ? "–" : targetLabel(target)}
          note={
            target === null
              ? t("serverAdmin.backup.noTarget")
              : target.kind === "s3"
                ? s3Place(target)
                : t("serverAdmin.backup.local")
          }
        />
      </FigureTiles>
      {editing ? (
        <TargetForm
          view={view}
          onClose={() => setEditing(false)}
          onSaved={async (message) => {
            setEditing(false);
            await refresh();
            notice.show({ message });
          }}
        />
      ) : target === null ? (
        <div className="settings-card settings-card--padded">
          <EmptyState
            icon="folder"
            title={t("serverAdmin.backup.noTarget")}
            actions={
              <button
                type="button"
                className="button button--primary"
                onClick={() => setEditing(true)}
              >
                {t("serverAdmin.backup.setUp")}
              </button>
            }
          >
            {t("serverAdmin.backup.noTargetText")}
          </EmptyState>
        </div>
      ) : null}
      {settings.data === undefined ? null : (
        <div className="settings-card">
          <PlainRow setting={byKey.get("backups.schedule_enabled")} changes={changes} />
          <PlainRow setting={byKey.get("backups.interval_hours")} changes={changes} />
          <PlainRow setting={byKey.get("backups.keep_count")} changes={changes} />
          <PlainRow
            setting={byKey.get("backups.encrypt")}
            changes={changes}
            note={t("serverAdmin.backup.keyNote")}
          />
          <PlainRow setting={byKey.get("backups.allowed_dirs")} changes={changes} />
          <RowsConflict changes={changes} />
        </div>
      )}
      {view.databaseIncluded ? null : (
        <p className="notice">
          <Icon name="info" />
          <span>{t("serverAdmin.backup.postgres")}</span>
        </p>
      )}
      <section className="settings-card" aria-labelledby="backup-runs">
        <div className="s75-card-head">
          <h3 className="s75-title" id="backup-runs">
            {t("serverAdmin.backup.runs")}
          </h3>
        </div>
        {runs.data === undefined || runs.data.length === 0 ? (
          <p className="s75-empty">
            {runs.data === undefined ? t("common.loading") : t("serverAdmin.backup.noRuns")}
          </p>
        ) : (
          // The list table of the app: numbers at the right edge, one block per run on a phone.
          <div className="s75-runs__frame">
            <table
              className="data-table data-table--stack s75-runs"
              aria-labelledby="backup-runs"
              {...STACK_ROLES.table}
            >
              <thead {...STACK_ROLES.rowgroup}>
                <tr {...STACK_ROLES.row}>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("annotations.time")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("admin.updates.history.kind")}
                  </th>
                  <th scope="col" className="s75-num" {...STACK_ROLES.columnheader}>
                    {t("serverAdmin.backup.size")}
                  </th>
                  <th scope="col" className="s75-num" {...STACK_ROLES.columnheader}>
                    {t("admin.updates.history.duration")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("admin.updates.history.result")}
                  </th>
                </tr>
              </thead>
              <tbody {...STACK_ROLES.rowgroup}>
                {runs.data.map((run) => (
                  <tr key={run.id} {...STACK_ROLES.row}>
                    <td className="s75-runs__time" {...STACK_ROLES.cell}>
                      {formatDateTime(run.startedAt, language, timeZone)}
                    </td>
                    <td data-label={t("admin.updates.history.kind")} {...STACK_ROLES.cell}>
                      {t(`serverAdmin.backup.kind.${run.kind}`)}
                      <span className="data-table__muted">
                        {" · "}
                        {run.targetKind === "s3" ? "S3" : t("serverAdmin.backup.local")}
                      </span>
                    </td>
                    <td
                      className="s75-num"
                      data-label={t("serverAdmin.backup.size")}
                      {...STACK_ROLES.cell}
                    >
                      {run.sizeBytes === null ? "–" : formatBytes(run.sizeBytes, language)}
                    </td>
                    <td
                      className="s75-num"
                      data-label={t("admin.updates.history.duration")}
                      {...STACK_ROLES.cell}
                    >
                      {seconds(run, language)}
                    </td>
                    <td data-label={t("admin.updates.history.result")} {...STACK_ROLES.cell}>
                      {run.status === "failed" ? (
                        <>
                          <span className="s75-danger">{t("alerting.state.error")}</span>
                          <span className="s75-runs__sub">{runProblem(t, run)}</span>
                        </>
                      ) : run.status === "running" ? (
                        t("serverAdmin.backup.running")
                      ) : (
                        <>
                          {t("admin.updates.history.installed")}
                          {run.detail === null ? null : (
                            <span className="s75-runs__sub">{run.detail}</span>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

interface Draft {
  kind: "local" | "s3";
  path: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  /** Empty keeps the stored secret (same store, bucket and key id). */
  secret: string;
}

function toDraft(target: BackupTarget | null): Draft {
  const s3 = target?.kind === "s3" ? target : undefined;
  return {
    kind: target?.kind ?? "local",
    path: target?.kind === "local" ? target.path : "",
    endpoint: s3?.endpoint ?? "",
    region: s3?.region ?? "",
    bucket: s3?.bucket ?? "",
    prefix: s3?.prefix ?? "",
    pathStyle: s3?.pathStyle ?? false,
    accessKeyId: s3?.accessKeyId ?? "",
    secret: "",
  };
}

function fromDraft(draft: Draft): BackupTarget {
  return draft.kind === "local"
    ? { kind: "local", path: draft.path.trim() }
    : {
        kind: "s3",
        endpoint: draft.endpoint.trim(),
        region: draft.region.trim(),
        bucket: draft.bucket.trim(),
        prefix: draft.prefix.trim(),
        pathStyle: draft.pathStyle,
        accessKeyId: draft.accessKeyId.trim(),
      };
}

const FIELDS: readonly BackupField[] = [
  "path",
  "endpoint",
  "region",
  "bucket",
  "prefix",
  "accessKeyId",
  "secretAccessKey",
];

const S3_FIELDS: readonly {
  field: Exclude<BackupField, "path" | "secretAccessKey">;
  title: MessageKey;
  placeholder: string;
}[] = [
  {
    field: "endpoint",
    title: "admin.serviceAccounts.scimEndpoint",
    placeholder: "https://s3.example.com",
  },
  { field: "region", title: "serverAdmin.backup.region", placeholder: "us-east-1" },
  { field: "bucket", title: "serverAdmin.backup.bucket", placeholder: "kalzit-backups" },
  { field: "prefix", title: "serverAdmin.backup.prefix", placeholder: "prod/" },
  { field: "accessKeyId", title: "serverAdmin.backup.keyId", placeholder: "" },
];

/**
 * The target's form (frame 7): a local folder or an S3-compatible store. "Test" checks the
 * values as typed; Save is offered once exactly these values passed the test, and a refusal
 * stands at the field that caused it, which then takes the focus.
 */
function TargetForm({
  view,
  onClose,
  onSaved,
}: {
  view: BackupsView;
  onClose: () => void;
  onSaved: (message: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const formRef = useRef<HTMLFormElement>(null);
  const [draft, setDraft] = useState(() => toDraft(view.target));
  const [problem, setProblem] = useState<{ field: BackupField | undefined; text: string } | null>(
    null,
  );
  /** The values the last passed test ran with. */
  const [passed, setPassed] = useState<string | null>(null);
  const signature = JSON.stringify(draft);
  const secret = draft.secret === "" ? undefined : draft.secret;
  const fail = (error: unknown) => {
    const field = isApiError(error) ? FIELDS.find((name) => name === error.field) : undefined;
    setProblem({ field, text: failureText(t, error) });
    setPassed(null);
    // The first field with an error takes the focus.
    requestAnimationFrame(() =>
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus(),
    );
  };
  // The test names the values it ran with: a change while it runs is not what passed.
  const test = useMutation({
    mutationFn: (_tested: string) =>
      testBackupTarget(fromDraft(draft), draft.kind === "s3" ? secret : undefined),
    onSuccess: (_, tested) => {
      setProblem(null);
      setPassed(tested);
    },
    onError: fail,
  });
  const save = useMutation({
    mutationFn: () =>
      saveBackupTarget(fromDraft(draft), draft.kind === "s3" ? secret : undefined, view.version),
    onSuccess: async (saved) => {
      queryClient.setQueryData(backupsKey, saved);
      await queryClient.invalidateQueries({ queryKey: adminKeys.serverSettings });
      await onSaved(t("serverAdmin.backup.saved"));
    },
    onError: fail,
  });
  const remove = useMutation({
    mutationFn: () => saveBackupTarget(null, undefined, view.version),
    onSuccess: async (saved) => {
      queryClient.setQueryData(backupsKey, saved);
      await onSaved(t("serverAdmin.backup.removed"));
    },
    onError: fail,
  });
  const change = (patch: Partial<Draft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setProblem(null);
  };
  const [removing, setRemoving] = useState(false);
  const errorFor = (field: BackupField) => (problem?.field === field ? problem.text : undefined);
  const busy = test.isPending || save.isPending || remove.isPending;
  const tested = passed === signature;
  return (
    <form
      ref={formRef}
      className="settings-card"
      aria-label={t("serverAdmin.backup.edit")}
      onSubmit={(event) => {
        event.preventDefault();
        if (tested && !busy) save.mutate();
      }}
    >
      <fieldset className="s75-kinds">
        <legend className="visually-hidden">{t("serverAdmin.backup.target")}</legend>
        {(["local", "s3"] as const).map((kind) => (
          <label key={kind} className="s75-kind">
            <input
              type="radio"
              name="backup-kind"
              checked={draft.kind === kind}
              onChange={() => change({ kind })}
            />
            <span>{t(`serverAdmin.backup.${kind}`)}</span>
            <span className="s75-kind__sub">{t(`serverAdmin.backup.${kind}Hint`)}</span>
          </label>
        ))}
      </fieldset>
      {draft.kind === "local" ? (
        <Field
          id="backup.path"
          title={t("dashboards.column.folder")}
          description={t("serverAdmin.backup.pathHint")}
          error={errorFor("path")}
        >
          {(labelled) => (
            <input
              className="input input--mono s75-wide"
              value={draft.path}
              spellCheck={false}
              autoComplete="off"
              {...labelled}
              onChange={(event) => change({ path: event.currentTarget.value })}
            />
          )}
        </Field>
      ) : (
        <>
          {S3_FIELDS.map(({ field, title, placeholder }) => (
            <Field
              key={field}
              id={`backup.${field}`}
              title={t(title)}
              description=""
              error={errorFor(field)}
            >
              {(labelled) => (
                <input
                  className="input input--mono s75-wide"
                  value={draft[field]}
                  placeholder={placeholder}
                  spellCheck={false}
                  autoComplete="off"
                  {...labelled}
                  onChange={(event) => change({ [field]: event.currentTarget.value })}
                />
              )}
            </Field>
          ))}
          <Field
            id="backup.secretAccessKey"
            title={t("serverAdmin.backup.secret")}
            description={view.hasSecret ? t("serverAdmin.backup.secretStored") : ""}
            error={errorFor("secretAccessKey")}
          >
            {(labelled) => (
              <input
                className="input s75-wide"
                type="password"
                autoComplete="new-password"
                placeholder={view.hasSecret ? "••••••••••••" : ""}
                value={draft.secret}
                {...labelled}
                onChange={(event) => change({ secret: event.currentTarget.value })}
              />
            )}
          </Field>
          <Field
            id="backup.pathStyle"
            title={t("serverAdmin.backup.pathStyle")}
            description=""
            error={undefined}
          >
            {(labelled) => (
              <input
                type="checkbox"
                className="settings-switch"
                role="switch"
                checked={draft.pathStyle}
                aria-checked={draft.pathStyle}
                {...labelled}
                onChange={(event) => change({ pathStyle: event.currentTarget.checked })}
              />
            )}
          </Field>
        </>
      )}
      <div className="s75-footer">
        <div className="s75-footer__result" role="status" aria-live="polite">
          {problem !== null ? (
            <p className="s75-danger">
              {t("serverAdmin.backup.testFailed")}
              {problem.field === undefined ? ` ${problem.text}` : ""}
            </p>
          ) : tested ? (
            <p className="s75-ok">{t("serverAdmin.backup.testPassed")}</p>
          ) : (
            <p className="s75-muted">{t("serverAdmin.backup.testFirst")}</p>
          )}
        </div>
        <div className="s75-footer__actions">
          {view.target === null ? null : (
            <button
              type="button"
              className="button button--ghost"
              disabled={busy}
              onClick={() => setRemoving(true)}
            >
              {t("admin.common.remove")}
            </button>
          )}
          <button type="button" className="button button--ghost" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--secondary"
            disabled={busy}
            onClick={() => test.mutate(signature)}
          >
            {test.isPending ? t("common.loading") : t("datasources.drawer.test")}
          </button>
          <button type="submit" className="button button--primary" disabled={!tested || busy}>
            {t("admin.common.save")}
          </button>
        </div>
      </div>
      <ConfirmDialog
        alert
        open={removing}
        title={t("serverAdmin.backup.removeTitle")}
        confirmLabel={t("admin.common.remove")}
        busy={remove.isPending}
        onConfirm={() => {
          setRemoving(false);
          remove.mutate();
        }}
        onClose={() => setRemoving(false)}
      >
        {t("serverAdmin.backup.removeText")}
      </ConfirmDialog>
    </form>
  );
}

/** One field of the target's form, in the rows of the settings board. */
function Field({
  id,
  title,
  description,
  error,
  children,
}: {
  id: string;
  title: string;
  description: string;
  error: string | undefined;
  children: (labelled: Record<string, string | boolean | undefined>) => ReactNode;
}) {
  const titleId = useId();
  const errorId = `${titleId}-error`;
  const described = [
    error === undefined ? undefined : errorId,
    description === "" ? undefined : `${titleId}-description`,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
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
      {children({
        "aria-labelledby": titleId,
        "aria-describedby": described === "" ? undefined : described,
        "aria-invalid": error === undefined ? undefined : true,
      })}
    </RowFrame>
  );
}
