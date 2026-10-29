import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type DragEvent, useId, useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { type Language, type MessageKey, type Translate, useI18n } from "../../../i18n/i18n";
import { fromWall, wallOf } from "../../../lib/zonedTime";
import { errorReason, reasonText } from "../../datasources/reasons";
import { adminKeys, listServerSettings, updateServerSetting } from "../api";
import { Dialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { useNotice } from "../components/Notice";
import { LoadState, Section } from "../components/Section";
import { errorText } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import {
  applyUpdate,
  type Backup,
  backupNow,
  backupUrl,
  checkUpdates,
  discardUpdate,
  downloadUpdate,
  getUpdates,
  type Highlight,
  type HistoryEntry,
  type Job,
  type ReasonView,
  rollbackTo,
  scheduleUpdate,
  skipUpdate,
  type UpdateStatus,
  unscheduleUpdate,
  updateKeys,
  uploadPackage,
} from "./updatesApi";
import "./updates.css";

/** Phases in which the status changes by itself; the page asks again every second. */
const BUSY = new Set(["checking", "downloading", "applying", "restarting"]);

/** The text of a reason the server reported, else its English message. */
function reasonOf(t: Translate, view: ReasonView): string {
  return (
    reasonText(t, { reason: view.reason, params: view.params, fallback: view.message }) ??
    view.message
  );
}

/** The text of a failed request: its update reason when it has one, else the error code's text. */
function failure(t: Translate, error: unknown): string {
  const reason = errorReason(error);
  return (reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error);
}

function formatBytes(bytes: number, language: Language): string {
  const units = ["byte", "kilobyte", "megabyte", "gigabyte"] as const;
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < units.length - 1) {
    value /= 1000;
    unit += 1;
  }
  return new Intl.NumberFormat(language, {
    style: "unit",
    unit: units[unit],
    maximumFractionDigits: unit === 0 ? 0 : 1,
  }).format(value);
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

/** `HH:MM-HH:MM` as minutes after midnight. */
function parseWindow(window: string): { start: number; end: number } | undefined {
  const match = /^(\d{2}):(\d{2})-(\d{2}):(\d{2})$/.exec(window);
  if (match === null) {
    return undefined;
  }
  const [, sh, sm, eh, em] = match.map(Number);
  return { start: (sh ?? 0) * 60 + (sm ?? 0), end: (eh ?? 0) * 60 + (em ?? 0) };
}

/** The next start of the maintenance window after `now`, in `zone`, and the window's end. */
export function nextWindow(
  window: string,
  now: number,
  zone: string | null,
): { at: number; until: number } | undefined {
  const parsed = parseWindow(window);
  if (parsed === undefined) {
    return undefined;
  }
  const today = wallOf(now, zone);
  for (const offset of [0, 1, 2]) {
    const at = fromWall(
      {
        ...today,
        day: today.day + offset,
        hour: Math.floor(parsed.start / 60),
        minute: parsed.start % 60,
        second: 0,
        millisecond: 0,
      },
      zone,
    );
    if (at > now) {
      const length = (parsed.end - parsed.start + 24 * 60) % (24 * 60);
      return { at, until: at + length * 60_000 };
    }
  }
  return undefined;
}

function timeOfDay(ms: number, language: Language, zone: string | null): string {
  return new Intl.DateTimeFormat(language, {
    hour: "2-digit",
    minute: "2-digit",
    ...(zone === null ? {} : { timeZone: zone }),
  }).format(new Date(ms));
}

const KIND_LABEL: Record<Highlight["kind"], MessageKey> = {
  new: "admin.updates.notes.new",
  improved: "admin.updates.notes.improved",
  fixed: "admin.updates.notes.fixed",
  security: "admin.updates.notes.security",
};

const MODE_TEXT: Record<string, MessageKey> = {
  "updates.mode_windows_service": "admin.updates.mode.windowsService",
  "updates.mode_not_systemd": "admin.updates.mode.notSystemd",
  "updates.mode_binary_not_writable": "admin.updates.mode.binaryNotWritable",
  "updates.mode_container": "admin.updates.mode.container",
  "updates.mode_unsupported_platform": "admin.updates.mode.unsupported",
};

/** Installed from the deb or rpm: the text and the command that installs a release's package. */
const PACKAGE_MODES: Record<string, { text: MessageKey; command: (version: string) => string }> = {
  "updates.mode_deb": {
    text: "admin.updates.mode.deb",
    command: (version) => `sudo apt install ./kalzit-${version}-linux-x64.deb`,
  },
  "updates.mode_rpm": {
    text: "admin.updates.mode.rpm",
    command: (version) => `sudo dnf install ./kalzit-${version}-linux-x64.rpm`,
  },
};

type Confirm =
  | { kind: "install"; version: string }
  /** Only on PostgreSQL: planning asks for the own backup up front. */
  | { kind: "schedule"; version: string; at: number; until: number }
  | { kind: "rollback"; version: string; restore: boolean };

/**
 * Updates: the installed version and channel, a new release with its notes and the checks before
 * it is installed, offline packages, backups and the history with returns to kept versions. Only
 * server admins open it; the server checks every request on its own.
 */
export function UpdatesPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const status = useQuery({
    queryKey: updateKeys.status,
    queryFn: getUpdates,
    enabled: access.isServerAdmin,
    refetchInterval: (query) =>
      query.state.data !== undefined && BUSY.has(query.state.data.job.phase) ? 1000 : false,
    retry: (count) => count < 30,
    retryDelay: 1000,
  });
  const settings = useQuery({
    queryKey: adminKeys.serverSettings,
    queryFn: listServerSettings,
    enabled: access.isServerAdmin,
  });

  const act = useMutation({
    mutationFn: (run: () => Promise<UpdateStatus>) => run(),
    onSuccess: (data) => queryClient.setQueryData(updateKeys.status, data),
    onError: (error) => {
      notice.showError(failure(t, error));
      // A refused step is in the history and may have changed the job.
      void queryClient.invalidateQueries({ queryKey: updateKeys.status });
    },
  });
  const run = (call: () => Promise<UpdateStatus>, done?: string) =>
    act.mutate(call, {
      onSuccess: () => (done === undefined ? undefined : notice.show({ message: done })),
    });

  const setSetting = useMutation({
    mutationFn: async ({ key, value }: { key: string; value: unknown }) => {
      const current = settings.data?.find((s) => s.key === key);
      return updateServerSetting(key, value, current?.version ?? 0);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: adminKeys.serverSettings });
      await queryClient.invalidateQueries({ queryKey: updateKeys.status });
    },
    onError: (error) => notice.showError(failure(t, error)),
  });
  const lockedSetting = (key: string) =>
    settings.data?.find((s) => s.key === key)?.editable === false;

  const data = status.data;
  return (
    <Section
      title="admin.updates.title"
      lead="admin.updates.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
      actions={
        <>
          <Link to="/admin/server/audit" className="button button--ghost">
            <Icon name="checklist" />
            {t("admin.updates.log")}
          </Link>
          <button
            type="button"
            className="button button--secondary"
            disabled={
              data === undefined || (data.job.phase !== "idle" && data.job.phase !== "failed")
            }
            onClick={() => run(checkUpdates)}
          >
            <Icon name="refresh" />
            {data?.job.phase === "checking"
              ? t("admin.updates.checking")
              : t("admin.updates.checkNow")}
          </button>
        </>
      }
    >
      {data === undefined ? (
        <LoadState error={status.error} onRetry={() => void status.refetch()} />
      ) : (
        <div className="updates">
          {data.job.phase === "restarting" && status.isError ? (
            <p className="notice" role="status">
              <Icon name="refresh" />
              {t("admin.updates.restartingWait", { version: data.job.version })}
            </p>
          ) : null}
          <StatusStrip
            data={data}
            onChannel={(value) => setSetting.mutate({ key: "updates.channel", value })}
            onDaily={(value) => setSetting.mutate({ key: "updates.check_daily", value })}
            onWindow={(value) => setSetting.mutate({ key: "updates.window", value })}
            locked={lockedSetting}
          />
          <div className="updates__row">
            <ReleaseCard
              data={data}
              busy={act.isPending}
              onDownload={(version) => run(() => downloadUpdate(version))}
              onInstall={(version) => setConfirm({ kind: "install", version })}
              onSchedule={(version, at, until) =>
                data.database === "postgres"
                  ? setConfirm({ kind: "schedule", version, at, until })
                  : run(() => scheduleUpdate(version, at, until), t("admin.updates.scheduled"))
              }
              onUnschedule={() => run(unscheduleUpdate)}
              onSkip={(version) => run(() => skipUpdate(version))}
              onDiscard={() => run(discardUpdate)}
            />
            <div className="updates__side">
              <Preflight data={data} />
              <Progress job={data.job} />
            </div>
          </div>
          <div className="updates__row">
            <OfflineUpload
              data={data}
              busy={act.isPending}
              onFile={(file) => run(() => uploadPackage(file), t("admin.updates.offline.verified"))}
            />
            <Backups
              data={data}
              busy={act.isPending}
              onBackup={() => run(backupNow, t("admin.updates.backups.done"))}
            />
          </div>
          <History
            data={data}
            onReturn={(version, restore) => setConfirm({ kind: "rollback", version, restore })}
          />
        </div>
      )}
      <ConfirmDialog
        confirm={confirm}
        data={data}
        onClose={() => setConfirm(null)}
        onConfirm={(c, acknowledge) => {
          setConfirm(null);
          if (c.kind === "install") {
            run(() => applyUpdate(c.version, acknowledge));
          } else if (c.kind === "schedule") {
            run(
              () => scheduleUpdate(c.version, c.at, c.until, acknowledge),
              t("admin.updates.scheduled"),
            );
          } else {
            run(() => rollbackTo(c.version, c.restore));
          }
        }}
      />
    </Section>
  );
}

function StatusStrip({
  data,
  onChannel,
  onDaily,
  onWindow,
  locked,
}: {
  data: UpdateStatus;
  onChannel: (channel: string) => void;
  onDaily: (on: boolean) => void;
  onWindow: (window: string) => void;
  locked: (key: string) => boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const channelId = useId();
  const [editing, setEditing] = useState(false);
  const zoneName = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const window = parseWindow(data.window);
  const windowText =
    window === undefined
      ? data.window
      : t("admin.updates.window.daily", {
          from: data.window.slice(0, 5),
          to: data.window.slice(6),
        });
  return (
    <section className="updates-card updates-strip" aria-label={t("admin.updates.strip")}>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.updates.installed")}</span>
        <div className="updates-strip__value">
          <span className="updates-mono updates-strip__version">{data.installed.version}</span>
          {data.installed.since === null ? null : (
            <span className="updates-muted">
              {t("admin.updates.since", {
                date: formatDateTime(data.installed.since, language, timeZone),
              })}
            </span>
          )}
        </div>
        <div className="updates-muted updates-strip__meta">
          {t("admin.updates.platform", {
            platform: data.installed.platform === "windows" ? "Windows" : "Linux",
            arch: data.installed.arch,
          })}
        </div>
      </div>
      <div className="updates-strip__cell">
        <label htmlFor={channelId} className="updates-caps">
          {t("admin.updates.channel")}
        </label>
        <select
          id={channelId}
          className="select updates-strip__select"
          value={data.channel}
          disabled={locked("updates.channel")}
          onChange={(event) => onChannel(event.target.value)}
        >
          <option value="stable">{t("admin.updates.channel.stable")}</option>
          <option value="preview">{t("admin.updates.channel.preview")}</option>
        </select>
        <div className="updates-muted updates-strip__meta">
          {t(
            data.channel === "stable"
              ? "admin.updates.channel.stableHint"
              : "admin.updates.channel.previewHint",
          )}
        </div>
      </div>
      <div className="updates-strip__cell">
        <span className="updates-caps" id={`${channelId}-daily`}>
          {t("admin.updates.autoCheck")}
        </span>
        <div className="updates-strip__value">
          <button
            type="button"
            role="switch"
            aria-checked={data.checkDaily}
            aria-labelledby={`${channelId}-daily`}
            className="updates-switch"
            disabled={locked("updates.check_daily")}
            onClick={() => onDaily(!data.checkDaily)}
          >
            <span className="updates-switch__knob" />
          </button>
          <span>
            {t(data.checkDaily ? "admin.updates.autoCheck.on" : "admin.updates.autoCheck.off")}
          </span>
        </div>
        <div className="updates-muted updates-strip__meta">
          {data.lastCheck === null
            ? t("admin.updates.neverChecked")
            : data.lastCheck.error === null
              ? t("admin.updates.lastChecked", {
                  date: formatDateTime(data.lastCheck.at, language, timeZone),
                })
              : t("admin.updates.checkFailed", { reason: reasonOf(t, data.lastCheck.error) })}
        </div>
      </div>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.updates.window")}</span>
        <div className="updates-strip__value">
          <span className="updates-strong">{windowText}</span>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={locked("updates.window")}
            onClick={() => setEditing(true)}
          >
            {t("admin.updates.window.change")}
          </button>
        </div>
        <div className="updates-muted updates-strip__meta">
          {t("admin.updates.window.zone", { zone: zoneName })}
        </div>
      </div>
      <WindowDialog
        open={editing}
        window={data.window}
        onClose={() => setEditing(false)}
        onSave={(value) => {
          setEditing(false);
          onWindow(value);
        }}
      />
    </section>
  );
}

function WindowDialog({
  open,
  window,
  onClose,
  onSave,
}: {
  open: boolean;
  window: string;
  onClose: () => void;
  onSave: (window: string) => void;
}) {
  const { t } = useI18n();
  const [from, setFrom] = useState(window.slice(0, 5));
  const [to, setTo] = useState(window.slice(6));
  const fromId = useId();
  const toId = useId();
  const valid = /^\d{2}:\d{2}$/.test(from) && /^\d{2}:\d{2}$/.test(to) && from !== to;
  return (
    <Dialog
      open={open}
      title={t("admin.updates.window.title")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.updates.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            disabled={!valid}
            onClick={() => onSave(`${from}-${to}`)}
          >
            {t("admin.updates.window.save")}
          </button>
        </>
      }
    >
      <p>{t("admin.updates.window.text")}</p>
      <div className="updates-window">
        <div className="field">
          <label className="field__label" htmlFor={fromId}>
            {t("admin.updates.window.from")}
          </label>
          <input
            id={fromId}
            className="input"
            type="time"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor={toId}>
            {t("admin.updates.window.to")}
          </label>
          <input
            id={toId}
            className="input"
            type="time"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>
    </Dialog>
  );
}

function ReleaseCard({
  data,
  busy,
  onDownload,
  onInstall,
  onSchedule,
  onUnschedule,
  onSkip,
  onDiscard,
}: {
  data: UpdateStatus;
  busy: boolean;
  onDownload: (version: string) => void;
  onInstall: (version: string) => void;
  onSchedule: (version: string, at: number, until: number) => void;
  onUnschedule: () => void;
  onSkip: (version: string) => void;
  onDiscard: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const offer = data.available;
  const staged = data.staged;
  // An uploaded release stands in for the offer when it is not the offered one.
  const release =
    offer !== null && (staged === null || staged.version === offer.version)
      ? {
          version: offer.version,
          size: offer.size,
          sha256: offer.sha256,
          keyId: offer.keyId,
          notes: offer.notes,
          notesUrl: offer.notesUrl,
          highlights: offer.highlights,
          releasedAt: offer.releasedAt,
          channel: offer.channel,
          staged: offer.staged,
          offline: false,
        }
      : staged !== null
        ? {
            version: staged.version,
            size: staged.size,
            sha256: staged.sha256,
            keyId: staged.keyId,
            notes: staged.notes,
            notesUrl: staged.notesUrl,
            highlights: staged.highlights,
            releasedAt: null,
            channel: null,
            staged: true,
            offline: staged.source === "offline",
          }
        : null;
  if (release === null) {
    return (
      <section
        className="updates-card updates-release updates-release--empty"
        aria-label={t("admin.updates.release")}
      >
        <div className="updates-release__head">
          <span className="updates-tile">
            <Icon name="check" />
          </span>
          <div>
            <h2 className="updates-release__title">
              {t(
                data.trustedKeys.length === 0
                  ? "admin.updates.cannotVerify"
                  : "admin.updates.upToDate",
              )}
            </h2>
            <p className="updates-muted">
              {data.trustedKeys.length === 0
                ? t("admin.updates.noKey")
                : data.lastCheck === null
                  ? t("admin.updates.upToDateNever")
                  : t("admin.updates.upToDateText", { version: data.installed.version })}
            </p>
          </div>
        </div>
      </section>
    );
  }
  const working = busy || (data.job.phase !== "idle" && data.job.phase !== "failed");
  const window = nextWindow(data.window, Date.now(), timeZone);
  const scheduled = data.schedule?.version === release.version ? data.schedule : null;
  const packaged = data.mode.reason === null ? undefined : PACKAGE_MODES[data.mode.reason];
  const groups = (["new", "improved", "fixed", "security"] as const)
    .map((kind) => ({ kind, lines: release.highlights.filter((h) => h.kind === kind) }))
    .filter((g) => g.lines.length > 0);
  return (
    <section className="updates-card updates-release" aria-label={t("admin.updates.release")}>
      <div className="updates-release__head">
        <span className="updates-tile">
          <Icon name="download" />
        </span>
        <div className="updates-release__intro">
          <div className="updates-release__kicker">
            <span className="updates-caps">
              {release.offline ? t("admin.updates.uploaded") : t("admin.updates.newVersion")}
            </span>
            {release.channel === null ? null : (
              <span className="admin-badge">
                {t(
                  release.channel === "stable"
                    ? "admin.updates.channel.stable"
                    : "admin.updates.channel.preview",
                )}
              </span>
            )}
          </div>
          <h2 className="updates-release__title">
            Kalzit <span className="updates-mono">{release.version}</span>
          </h2>
          <div className="updates-release__facts">
            {release.releasedAt === null ? null : (
              <span>
                {t("admin.updates.released", {
                  date: new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
                    new Date(release.releasedAt),
                  ),
                })}
              </span>
            )}
            <span>{formatBytes(release.size, language)}</span>
            <span className="updates-release__signed">
              <Icon name="shieldCheck" />
              {t("admin.updates.signed")}
            </span>
            <span className="updates-mono updates-muted">
              {t("admin.updates.keyId", { id: release.keyId })}
            </span>
            <span className="updates-mono updates-muted" title={release.sha256}>
              sha256 {release.sha256.slice(0, 4)}…{release.sha256.slice(-3)}
            </span>
          </div>
        </div>
      </div>
      {groups.length > 0 ? (
        <div className="updates-notes">
          {groups.map((group) => (
            <div key={group.kind}>
              <h3 className="updates-notes__head">
                {t(KIND_LABEL[group.kind])}
                <span className="updates-count">{group.lines.length}</span>
              </h3>
              <ul className="updates-notes__list">
                {group.lines.slice(0, 3).map((line) => (
                  <li key={line.text}>{line.text}</li>
                ))}
                {group.lines.length > 3 ? (
                  <li className="updates-muted">
                    {t("admin.updates.notes.more", { count: group.lines.length - 3 })}
                  </li>
                ) : null}
              </ul>
            </div>
          ))}
        </div>
      ) : release.notes === "" ? null : (
        <p className="updates-notes updates-notes--plain">{release.notes}</p>
      )}
      {packaged !== undefined ? (
        // The package manager owns the binary: the release's package replaces it, no download here.
        <div className="updates-manual">
          <p>{t(packaged.text)}</p>
          <pre className="updates-mono updates-manual__command">
            {packaged.command(release.version)}
          </pre>
        </div>
      ) : data.mode.automatic || !release.staged ? null : (
        <div className="updates-manual">
          <p>
            {t(MODE_TEXT[data.mode.reason ?? ""] ?? "admin.updates.mode.unsupported")}{" "}
            {t("admin.updates.mode.command")}
          </p>
          <pre className="updates-mono updates-manual__command">kalzit update apply</pre>
        </div>
      )}
      <div className="updates-release__actions">
        {packaged !== undefined ? null : !release.staged ? (
          <button
            type="button"
            className="button button--primary"
            disabled={working}
            onClick={() => onDownload(release.version)}
          >
            <Icon name="download" />
            {t("admin.updates.download")}
          </button>
        ) : data.mode.automatic ? (
          <>
            <button
              type="button"
              className="button button--primary"
              disabled={working}
              onClick={() => onInstall(release.version)}
            >
              <Icon name="download" />
              {t("admin.updates.installNow")}
            </button>
            {scheduled !== null ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={working}
                onClick={onUnschedule}
              >
                <Icon name="clock" />
                {t("admin.updates.unschedule", {
                  time: formatDateTime(scheduled.at, language, timeZone),
                })}
              </button>
            ) : window === undefined ? null : (
              <button
                type="button"
                className="button button--secondary"
                disabled={working}
                onClick={() => onSchedule(release.version, window.at, window.until)}
              >
                <Icon name="clock" />
                {t(
                  wallOf(window.at, timeZone).day === wallOf(Date.now(), timeZone).day
                    ? "admin.updates.scheduleToday"
                    : "admin.updates.scheduleTomorrow",
                  { time: timeOfDay(window.at, language, timeZone) },
                )}
              </button>
            )}
          </>
        ) : null}
        {release.notesUrl === null ? null : (
          <a
            className="button button--ghost"
            href={release.notesUrl}
            target="_blank"
            rel="noreferrer noopener"
          >
            {t("admin.updates.fullNotes")}
            <Icon name="external" />
          </a>
        )}
        <span className="updates-spacer" />
        {release.staged ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={working}
            onClick={onDiscard}
          >
            {t("admin.updates.discard")}
          </button>
        ) : null}
        {offer !== null && offer.version === release.version ? (
          <button
            type="button"
            className="button button--ghost"
            disabled={working}
            onClick={() => onSkip(release.version)}
          >
            {t("admin.updates.skip")}
          </button>
        ) : null}
      </div>
    </section>
  );
}

function Preflight({ data }: { data: UpdateStatus }) {
  const { t, language } = useI18n();
  const p = data.preflight;
  const enoughSpace =
    p.freeBytes === null ||
    p.backupBytes === null ||
    p.freeBytes > p.backupBytes * 2 + data.maxPackageBytes / 4;
  const items: { ok: boolean; title: string; detail: string }[] = [
    data.database === "sqlite"
      ? {
          ok: true,
          title: t("admin.updates.pre.backup"),
          detail: t("admin.updates.pre.backupSize", {
            size: formatBytes(p.backupBytes ?? 0, language),
          }),
        }
      : {
          ok: false,
          title: t("admin.updates.pre.backupPostgres"),
          detail: t("admin.updates.pre.backupPostgresHint"),
        },
    p.freeBytes === null
      ? { ok: true, title: t("admin.updates.pre.spaceUnknown"), detail: "" }
      : {
          ok: enoughSpace,
          title: t(enoughSpace ? "admin.updates.pre.spaceOk" : "admin.updates.pre.spaceLow"),
          detail: t("admin.updates.pre.spaceFree", { size: formatBytes(p.freeBytes, language) }),
        },
    {
      ok: true,
      title: t("admin.updates.pre.users", { count: p.activeUsers }),
      detail: t("admin.updates.pre.usersHint"),
    },
    {
      ok: true,
      title: t("admin.updates.pre.restart"),
      detail: t("admin.updates.pre.restartHint", {
        version: data.installed.version,
        seconds: p.healthTimeoutSecs,
      }),
    },
  ];
  const ready = items.every((i) => i.ok);
  return (
    <section className="updates-card updates-side-card" aria-label={t("admin.updates.pre.title")}>
      <div className="updates-side-card__head">
        <h2 className="updates-caps">{t("admin.updates.pre.title")}</h2>
        <span className={ready ? "updates-ok" : "updates-warn"}>
          {t(ready ? "admin.updates.pre.ready" : "admin.updates.pre.check")}
        </span>
      </div>
      <ul className="updates-checks">
        {items.map((item) => (
          <li key={item.title} className="updates-checks__item">
            <span className={item.ok ? "updates-ok" : "updates-warn"}>
              <Icon name={item.ok ? "check" : "alert"} />
            </span>
            <div>
              <div>{item.title}</div>
              {item.detail === "" ? null : <div className="updates-muted">{item.detail}</div>}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** In the server's order: the new binary runs before anything is backed up or replaced. */
const STEPS = ["verify", "backup", "replace", "restart"] as const;
const STEP_LABEL: Record<(typeof STEPS)[number], MessageKey> = {
  backup: "admin.updates.step.backup",
  verify: "admin.updates.step.verify",
  replace: "admin.updates.step.replace",
  restart: "admin.updates.step.restart",
};

function Progress({ job }: { job: Job }) {
  const { t, language } = useI18n();
  if (job.phase === "failed") {
    return (
      <section className="updates-card updates-side-card" aria-label={t("admin.updates.progress")}>
        <div className="notice notice--danger" role="alert">
          <Icon name="alert" />
          <div>{reasonOf(t, job.error)}</div>
        </div>
      </section>
    );
  }
  if (job.phase === "downloading") {
    const percent = job.bytesTotal === 0 ? 0 : Math.round((job.bytesDone / job.bytesTotal) * 100);
    return (
      <section className="updates-card updates-side-card" aria-label={t("admin.updates.progress")}>
        <div className="updates-side-card__head">
          <h2 className="updates-caps">{t("admin.updates.progress")}</h2>
          <span className="updates-mono updates-muted">{percent} %</span>
        </div>
        <div className="updates-strong">
          {t("admin.updates.downloading", { version: job.version })}
        </div>
        <div className="updates-muted">
          {formatBytes(job.bytesDone, language)} / {formatBytes(job.bytesTotal, language)}
        </div>
        <progress
          className="updates-bar"
          aria-label={t("admin.updates.downloading", { version: job.version })}
          max={100}
          value={percent}
        />
      </section>
    );
  }
  if (job.phase !== "applying" && job.phase !== "restarting") {
    return null;
  }
  const order = job.phase === "restarting" ? 3 : STEPS.indexOf(job.step);
  const percent = Math.round(((order + 0.5) / STEPS.length) * 100);
  return (
    <section className="updates-card updates-side-card" aria-label={t("admin.updates.progress")}>
      <div className="updates-side-card__head">
        <h2 className="updates-caps">{t("admin.updates.progress")}</h2>
        <span className="updates-mono updates-muted">{percent} %</span>
      </div>
      <div className="updates-strong" role="status">
        {job.phase === "restarting"
          ? t("admin.updates.restarting", { version: job.version })
          : t("admin.updates.installing", { version: job.version })}
      </div>
      <progress
        className="updates-bar"
        aria-label={t("admin.updates.progress")}
        max={100}
        value={percent}
      />
      <ol className="updates-steps">
        {STEPS.map((step, index) => (
          <li
            key={step}
            className={
              index < order
                ? "updates-steps__item updates-steps__item--done"
                : index === order
                  ? "updates-steps__item updates-steps__item--current"
                  : "updates-steps__item"
            }
            aria-current={index === order ? "step" : undefined}
          >
            {index < order ? <Icon name="check" /> : <span className="updates-steps__dot" />}
            {t(STEP_LABEL[step])}
          </li>
        ))}
      </ol>
    </section>
  );
}

function OfflineUpload({
  data,
  busy,
  onFile,
}: {
  data: UpdateStatus;
  busy: boolean;
  onFile: (file: File) => void;
}) {
  const { t, language } = useI18n();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const inputId = useId();
  const take = (files: FileList | null) => {
    const file = files?.[0];
    if (file !== undefined) {
      onFile(file);
    }
  };
  const drop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setOver(false);
    if (!busy) {
      take(event.dataTransfer.files);
    }
  };
  return (
    <section className="updates-card updates-offline" aria-label={t("admin.updates.offline.title")}>
      <div className="updates-offline__main">
        <div className="updates-offline__head">
          <h2 className="updates-section-title">{t("admin.updates.offline.title")}</h2>
          <span className="admin-badge">{t("admin.updates.offline.badge")}</span>
        </div>
        <p className="updates-muted">{t("admin.updates.offline.lead")}</p>
        <label
          htmlFor={inputId}
          className={over ? "updates-drop updates-drop--over" : "updates-drop"}
          onDragOver={(event) => {
            event.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={drop}
        >
          <span className="updates-tile">
            <Icon name="upload" />
          </span>
          <span className="updates-strong">
            {t("admin.updates.offline.drop")}{" "}
            <span className="updates-drop__pick">{t("admin.updates.offline.pick")}</span>
          </span>
          <span className="updates-muted">
            <span className="updates-mono">.kalzit-update</span> ·{" "}
            {t("admin.updates.offline.max", { size: formatBytes(data.maxPackageBytes, language) })}
          </span>
          <input
            ref={input}
            id={inputId}
            className="visually-hidden"
            type="file"
            accept=".kalzit-update"
            disabled={busy}
            onChange={(event) => {
              take(event.target.files);
              event.target.value = "";
            }}
          />
        </label>
      </div>
      <div className="updates-offline__how">
        <h3 className="updates-caps">{t("admin.updates.offline.how")}</h3>
        <ol className="updates-how">
          {(
            [
              ["admin.updates.offline.step1", "admin.updates.offline.step1Hint"],
              ["admin.updates.offline.step2", "admin.updates.offline.step2Hint"],
              ["admin.updates.offline.step3", "admin.updates.offline.step3Hint"],
            ] as const
          ).map(([title, hint], index) => (
            <li key={title} className="updates-how__item">
              <span className="updates-how__number">{index + 1}</span>
              <div>
                <div className="updates-strong">{t(title)}</div>
                <div className="updates-muted">{t(hint)}</div>
              </div>
            </li>
          ))}
        </ol>
        <p className="updates-hint">{t("admin.updates.offline.where")}</p>
      </div>
    </section>
  );
}

function personName(data: UpdateStatus, id: string | null, t: Translate): string {
  if (id === null) {
    return t("admin.updates.system");
  }
  return data.people.find((p) => p.id === id)?.name ?? t("admin.updates.unknownUser");
}

function Backups({
  data,
  busy,
  onBackup,
}: {
  data: UpdateStatus;
  busy: boolean;
  onBackup: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const total = data.backups.reduce((sum, b) => sum + b.size, 0);
  const label = (b: Backup) =>
    b.kind === "manual"
      ? t("admin.updates.backups.manual")
      : t("admin.updates.backups.before", { version: b.version });
  return (
    <section className="updates-card updates-backups" aria-label={t("admin.updates.backups.title")}>
      <div className="updates-backups__head">
        <h2 className="updates-section-title">{t("admin.updates.backups.title")}</h2>
        <span className="updates-muted">
          {t("admin.updates.backups.summary", {
            count: data.backups.length,
            size: formatBytes(total, language),
          })}
        </span>
        <span className="updates-spacer" />
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={busy || data.database !== "sqlite"}
          onClick={onBackup}
        >
          {t("admin.updates.backups.now")}
        </button>
      </div>
      {data.database !== "sqlite" ? (
        <p className="updates-muted updates-backups__empty">
          {t("admin.updates.backups.postgres")}
        </p>
      ) : data.backups.length === 0 ? (
        <p className="updates-muted updates-backups__empty">{t("admin.updates.backups.none")}</p>
      ) : (
        <ul className="updates-backups__list" aria-label={t("admin.updates.backups.title")}>
          {data.backups.map((b) => (
            <li key={b.file} className="updates-backups__item">
              <Icon name="database" />
              <div className="updates-backups__text">
                <div>{label(b)}</div>
                <div className="updates-muted">
                  {formatDateTime(b.at, language, timeZone)}
                  {b.kind === "manual" ? ` · ${personName(data, b.by, t)}` : ""}
                </div>
              </div>
              <span className="updates-mono updates-muted">{formatBytes(b.size, language)}</span>
              <a
                className="button button--secondary button--small updates-icon-button"
                href={backupUrl(b.file)}
                download={b.file}
                aria-label={t("admin.updates.backups.download", { name: label(b) })}
              >
                <Icon name="download" />
              </a>
            </li>
          ))}
        </ul>
      )}
      <p className="updates-hint updates-backups__foot">{t("admin.updates.backups.foot")}</p>
    </section>
  );
}

type Filter = "all" | "online" | "offline" | "failed";
const FILTERS: Filter[] = ["all", "online", "offline", "failed"];

const OUTCOME_TEXT: Record<HistoryEntry["outcome"], MessageKey> = {
  installed: "admin.updates.history.installed",
  rolledBack: "admin.updates.history.rolledBack",
  aborted: "admin.updates.history.aborted",
};

function History({
  data,
  onReturn,
}: {
  data: UpdateStatus;
  onReturn: (version: string, restore: boolean) => void;
}) {
  const { t, language, timeZone } = useI18n();
  const [filter, setFilter] = useState<Filter>("all");
  const shown = data.history.filter((h) =>
    filter === "all" ? true : filter === "failed" ? h.outcome !== "installed" : h.source === filter,
  );
  const kindText = (h: HistoryEntry) => {
    const source =
      h.kind === "rollback"
        ? t("admin.updates.history.return")
        : h.source === "offline"
          ? t("admin.updates.history.offline")
          : t("admin.updates.history.online");
    return h.scheduled ? `${source} · ${t("admin.updates.history.planned")}` : source;
  };
  const targets = new Map(data.rollbackTargets.map((r) => [r.version, r]));
  const returned = new Set<string>();
  return (
    <section className="updates-card updates-history" aria-label={t("admin.updates.history.title")}>
      <div className="updates-history__head">
        <h2 className="updates-section-title">{t("admin.updates.history.title")}</h2>
        <span className="updates-muted">
          {t("admin.updates.history.count", { count: data.history.length })}
        </span>
        <span className="updates-spacer" />
        <fieldset className="updates-filters">
          <legend className="visually-hidden">{t("admin.updates.history.filter")}</legend>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="updates-filters__button"
              aria-pressed={filter === f}
              onClick={() => setFilter(f)}
            >
              {t(`admin.updates.history.filter.${f}`)}
            </button>
          ))}
        </fieldset>
      </div>
      {shown.length === 0 ? (
        <p className="updates-muted updates-history__empty">{t("admin.updates.history.none")}</p>
      ) : (
        <div className="updates-table-wrap">
          <table className="updates-table">
            <thead>
              <tr>
                <th scope="col">{t("admin.updates.history.version")}</th>
                <th scope="col">{t("admin.updates.history.date")}</th>
                <th scope="col">{t("admin.updates.history.kind")}</th>
                <th scope="col">{t("admin.updates.history.by")}</th>
                <th scope="col">{t("admin.updates.history.result")}</th>
                <th scope="col">{t("admin.updates.history.duration")}</th>
                <th scope="col">
                  <span className="visually-hidden">{t("admin.updates.history.action")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.map((h) => {
                const target = targets.get(h.version);
                const offerReturn =
                  h.outcome === "installed" &&
                  target !== undefined &&
                  target.restorePossible &&
                  !returned.has(h.version);
                if (offerReturn) {
                  returned.add(h.version);
                }
                const current = h.outcome === "installed" && h.version === data.installed.version;
                return (
                  <tr key={`${h.version}-${h.at}`}>
                    <td>
                      <span className="updates-mono">{h.version}</span>
                      {current ? (
                        <span className="admin-badge updates-history__current">
                          {t("admin.updates.history.current")}
                        </span>
                      ) : null}
                    </td>
                    <td>{formatDateTime(h.at, language, timeZone)}</td>
                    <td>{kindText(h)}</td>
                    <td>{personName(data, h.actor, t)}</td>
                    <td>
                      <span className={h.outcome === "installed" ? "updates-ok" : "updates-warn"}>
                        {t(OUTCOME_TEXT[h.outcome])}
                      </span>
                      {h.outcome === "installed" ? null : (
                        <div className="updates-muted">
                          {h.reasonCode === null
                            ? (h.reason ?? "")
                            : reasonOf(t, {
                                reason: h.reasonCode,
                                params: {},
                                message: h.reason ?? "",
                              })}
                        </div>
                      )}
                    </td>
                    <td className="updates-mono">
                      {h.durationMs === null ? "" : formatDuration(h.durationMs)}
                    </td>
                    <td>
                      {offerReturn && target !== undefined && data.mode.automatic ? (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          onClick={() => onReturn(h.version, target.needsDatabaseRestore)}
                        >
                          {t("admin.updates.history.returnTo")}
                        </button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {data.rollbackTargets.length > 0 && !data.mode.automatic ? (
        <p className="updates-hint">{t("admin.updates.history.manualReturn")}</p>
      ) : null}
    </section>
  );
}

function ConfirmDialog({
  confirm,
  data,
  onClose,
  onConfirm,
}: {
  confirm: Confirm | null;
  data: UpdateStatus | undefined;
  onClose: () => void;
  onConfirm: (confirm: Confirm, acknowledgeNoBackup: boolean) => void;
}) {
  const { t } = useI18n();
  const cancel = useRef<HTMLButtonElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const ackId = useId();
  if (confirm === null || data === undefined) {
    return null;
  }
  const postgres = data.database === "postgres";
  const installs = confirm.kind === "install" || confirm.kind === "schedule";
  const needsAck = installs && postgres;
  const title =
    confirm.kind === "install"
      ? t("admin.updates.confirm.installTitle", { version: confirm.version })
      : confirm.kind === "schedule"
        ? t("admin.updates.confirm.scheduleTitle", { version: confirm.version })
        : t("admin.updates.confirm.returnTitle", { version: confirm.version });
  return (
    <Dialog
      open
      title={title}
      onClose={onClose}
      initialFocus={cancel}
      footer={
        <>
          <button ref={cancel} type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.updates.cancel")}
          </button>
          <button
            type="button"
            className={
              confirm.kind === "rollback" && confirm.restore
                ? "button button--danger"
                : "button button--primary"
            }
            disabled={needsAck && !acknowledged}
            onClick={() => onConfirm(confirm, needsAck && acknowledged)}
          >
            {confirm.kind === "install"
              ? t("admin.updates.installNow")
              : confirm.kind === "schedule"
                ? t("admin.updates.confirm.schedule")
                : t("admin.updates.history.returnTo")}
          </button>
        </>
      }
    >
      {installs ? (
        <>
          <p>
            {t("admin.updates.confirm.installText", {
              version: data.installed.version,
              seconds: data.preflight.healthTimeoutSecs,
            })}
          </p>
          {needsAck ? (
            <label className="updates-ack" htmlFor={ackId}>
              <input
                id={ackId}
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              {t("admin.updates.confirm.postgres")}
            </label>
          ) : null}
        </>
      ) : (
        <p>
          {confirm.restore
            ? t("admin.updates.confirm.returnRestore", { version: confirm.version })
            : t("admin.updates.confirm.returnText", { version: confirm.version })}
        </p>
      )}
    </Dialog>
  );
}
