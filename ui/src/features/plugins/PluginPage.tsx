import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { type KeyboardEvent, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { Icon } from "../../components/Icon";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { ConfirmDialog, Dialog } from "../admin/components/Dialog";
import { LoadState } from "../admin/components/Section";
import { errorMessage } from "../dashboards/ui/errors";
import {
  approvePlugin,
  getPlugin,
  type Plugin,
  type PluginAction,
  type PluginDetail,
  pluginAction,
  pluginKeys,
  pluginLogs,
  removePlugin,
} from "./api";
import { refreshPlugins, useHostSwitch } from "./hooks";
import type { Grant } from "./InstallDialog";
import { kindLabel } from "./PluginsSection";
import {
  PluginMark,
  PluginStatusLabel,
  PublisherBadge,
  SignatureLabel,
  UnsignedBanner,
  useNow,
  usePlugins,
} from "./parts";
import {
  countdown,
  groupedKeyId,
  layerText,
  permissionText,
  pluginReasonText,
  sameLine,
} from "./status";
import "./plugins.css";

const TABS = ["overview", "manifest", "log", "used"] as const;
type Tab = (typeof TABS)[number];

const TAB_LABEL: Record<Tab, MessageKey> = {
  overview: "plugins.details.tab.overview",
  manifest: "plugins.details.tab.manifest",
  log: "plugins.details.tab.log",
  used: "plugins.details.tab.used",
};

/** The route component: server administrators only, like every plugin route. */
export function PluginRoutePage() {
  const { t } = useI18n();
  const { pluginId } = useParams({ from: "/_app/settings/plugins/$pluginId" });
  const permissions = useOrgPermissions();
  useDocumentTitle("plugins.title");
  if (!permissions.loaded) {
    return null;
  }
  if (!permissions.isServerAdmin) {
    return (
      <EmptyState icon="lock" title={t("admin.forbidden.title")}>
        {t("settings.noAccess")}
      </EmptyState>
    );
  }
  return <PluginPage pluginId={pluginId} />;
}

/**
 * One plugin (board frame 2, and frame 4 for a crash): who signed it, its manifest, the targets
 * it may reach, the process and its sandbox, its output, the data sources of its kind in every
 * organization, and approve, restart, turn on or off and remove.
 */
export function PluginPage({ pluginId }: { pluginId: string }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const tabsId = useId();
  const list = usePlugins();
  const hostSwitch = useHostSwitch();
  const detail = useQuery({
    queryKey: pluginKeys.one(pluginId),
    queryFn: ({ signal }) => getPlugin(pluginId, signal),
  });
  const [tab, setTab] = useState<Tab>("overview");
  const [removing, setRemoving] = useState(false);
  const [approving, setApproving] = useState(false);
  const waiting = detail.data?.process?.state === "waiting";
  const now = useNow(waiting);

  const refresh = () => refreshPlugins(queryClient);
  const act = useMutation({
    mutationFn: (action: PluginAction) => pluginAction(pluginId, action),
    onSuccess: (plugin, action) => {
      refresh();
      showToast({ message: t(`plugins.details.done.${action}`, { name: plugin.name }) });
    },
    onError: (error) => showToast({ message: errorMessage(t, error), error: true }),
  });
  const remove = useMutation({
    mutationFn: () => removePlugin(pluginId),
    onSuccess: () => {
      refresh();
      showToast({ message: t("plugins.details.removed", { name: detail.data?.name ?? pluginId }) });
      void navigate({ to: "/settings/$section", params: { section: "plugins" } });
    },
  });

  if (detail.data === undefined) {
    if (isApiError(detail.error, "not_found")) {
      return (
        <EmptyState icon="alert" title={t("plugins.details.missing")}>
          <Link to="/settings/$section" params={{ section: "plugins" }}>
            {t("plugins.details.back")}
          </Link>
        </EmptyState>
      );
    }
    return <LoadState error={detail.error} onRetry={() => void detail.refetch()} />;
  }
  const plugin = detail.data;
  const orgs = new Set(plugin.usedIn.map((source) => source.orgId));

  function onTabKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length] ?? tab;
    setTab(next);
    document.getElementById(`${tabsId}-${next}-tab`)?.focus();
  }

  const busy = act.isPending;
  const run = (action: PluginAction) => {
    if (!busy) act.mutate(action);
  };

  return (
    <div className="plugins">
      <Link to="/settings/$section" params={{ section: "plugins" }} className="back-link">
        <Icon name="back" />
        {t("plugins.details.back")}
      </Link>
      {list.data === undefined ? null : (
        <UnsignedBanner
          list={list.data}
          busy={hostSwitch.isPending}
          onTurnOff={() => hostSwitch.mutate({ allowUnsigned: false })}
        />
      )}
      <header className="plugin-head">
        <PluginMark name={plugin.name} large />
        <div className="plugin-head__text">
          <div className="plugin-head__title">
            <h2>{plugin.name}</h2>
            <span className="plugins-chip">{t(kindLabel(plugin.kind))}</span>
            <span className="plugins-mono">{plugin.version}</span>
            <PluginStatusLabel plugin={plugin} now={now} />
          </div>
          <p className="plugin-facts">
            <span className="plugins-mono" translate="no">
              {plugin.id}
            </span>
            <PublisherBadge publisher={plugin.publisher} />
            <SignatureLabel plugin={plugin} />
            {plugin.license === undefined ? null : (
              <span>{t("plugins.details.license", { license: plugin.license })}</span>
            )}
            <span>
              {t("plugins.details.installed", {
                date: new Intl.DateTimeFormat(language, { dateStyle: "medium" }).format(
                  plugin.installedAt,
                ),
              })}
            </span>
          </p>
          {plugin.description === undefined ? null : (
            <p className="plugins-hint">{plugin.description}</p>
          )}
        </div>
        <div className="plugin-head__actions">
          {plugin.pending !== undefined ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setApproving(true)}
            >
              {t("plugins.details.approveUpdate", { version: plugin.pending.version })}
            </button>
          ) : !plugin.approved ? (
            <button
              type="button"
              className="button button--primary"
              onClick={() => setApproving(true)}
            >
              {t("plugins.details.approve")}
            </button>
          ) : null}
          {plugin.approved && plugin.enabled ? (
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={busy}
              onClick={() => run("restart")}
            >
              <Icon name="refresh" />
              {t("plugins.details.restart")}
            </button>
          ) : null}
          {plugin.approved ? (
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={busy}
              onClick={() => run(plugin.enabled ? "disable" : "enable")}
            >
              {plugin.enabled ? t("plugins.details.turnOff") : t("plugins.details.turnOn")}
            </button>
          ) : null}
          <button type="button" className="button button--danger" onClick={() => setRemoving(true)}>
            <Icon name="trash" />
            {t("plugins.details.remove")}
          </button>
        </div>
      </header>
      <CrashNote
        plugin={plugin}
        now={now}
        onRestart={() => run("restart")}
        onLog={() => setTab("log")}
      />
      <div
        className="tabs"
        role="tablist"
        aria-label={t("plugins.details.tabs")}
        onKeyDown={onTabKey}
      >
        {TABS.map((name) => (
          <button
            key={name}
            type="button"
            role="tab"
            id={`${tabsId}-${name}-tab`}
            className="tabs__tab"
            aria-selected={tab === name}
            aria-controls={`${tabsId}-${name}`}
            tabIndex={tab === name ? 0 : -1}
            onClick={() => setTab(name)}
          >
            {t(TAB_LABEL[name])}
            {name === "used" ? (
              <span className="plugins__count">{plugin.usedIn.length}</span>
            ) : null}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`${tabsId}-${tab}`} aria-labelledby={`${tabsId}-${tab}-tab`}>
        {tab === "overview" ? (
          <Overview plugin={plugin} now={now} />
        ) : tab === "manifest" ? (
          <section className="plugins-card" aria-label={t("plugins.details.tab.manifest")}>
            <div className="plugins-card__head">
              <div className="plugins-card__title">
                <h3>{t("plugins.details.manifestTitle")}</h3>
                <p className="plugins-hint">{t("plugins.details.manifestLead")}</p>
              </div>
            </div>
            {/* biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard */}
            <pre className="plugin-manifest" translate="no" tabIndex={0}>
              {plugin.manifest}
            </pre>
          </section>
        ) : tab === "log" ? (
          <LogCard plugin={plugin} />
        ) : (
          <section className="plugins-card" aria-label={t("plugins.details.tab.used")}>
            <div className="plugins-card__body">
              {plugin.usedIn.length === 0 ? (
                <p className="plugins-hint">{t("plugins.details.usedNone")}</p>
              ) : (
                <>
                  <p className="plugins-hint">
                    {t("plugins.details.usedCount", {
                      count: plugin.usedIn.length,
                      orgs: orgs.size,
                    })}
                  </p>
                  <UsedList plugin={plugin} />
                </>
              )}
            </div>
          </section>
        )}
      </div>
      <ConfirmDialog
        open={removing}
        title={t("plugins.details.removeTitle", { name: plugin.name })}
        confirmLabel={t("plugins.details.remove")}
        busy={remove.isPending}
        error={remove.error === null ? undefined : errorMessage(t, remove.error)}
        onClose={() => {
          setRemoving(false);
          remove.reset();
        }}
        onConfirm={() => remove.mutate()}
      >
        <p>
          {plugin.usedIn.length === 0
            ? t("plugins.details.removeUnused")
            : t("plugins.details.removeUsed", {
                count: plugin.usedIn.length,
                orgs: orgs.size,
              })}
        </p>
      </ConfirmDialog>
      {approving ? <ApproveDialog plugin={plugin} onClose={() => setApproving(false)} /> : null}
    </div>
  );
}

/** A crashed or stopped plugin: when it starts again, and the way to start it now (frame 4). */
function CrashNote({
  plugin,
  now,
  onRestart,
  onLog,
}: {
  plugin: Plugin;
  now: number;
  onRestart: () => void;
  onLog: () => void;
}) {
  const { t } = useI18n();
  const process = plugin.process;
  if (process === undefined || (process.state !== "waiting" && process.state !== "stopped")) {
    return null;
  }
  const error = process.lastError;
  const remaining = Math.max(0, Math.ceil(((process.retryAt ?? now) - now) / 1000));
  // Announced at most every 30 seconds, not every second.
  const announced = Math.ceil(remaining / 30) * 30;
  return (
    <div className="plugins-note plugins-note--danger">
      <Icon name="alert" />
      <div className="plugins-stack">
        <strong>
          {process.state === "waiting"
            ? t("plugins.crash.waiting", { time: countdown(process.retryAt ?? now, now) })
            : t("plugins.crash.stopped")}
        </strong>
        {error === undefined ? null : (
          <span>{pluginReasonText(t, { reason: error.reason, fallback: error.message })}</span>
        )}
        {error?.message === undefined || error.message === "" ? null : (
          <span className="plugins-mono">{error.message}</span>
        )}
        <span className="plugins-small">{t("plugins.crash.backoff")}</span>
        {process.state === "waiting" ? (
          <span className="live-region" role="status">
            {t("plugins.crash.announce", { seconds: announced })}
          </span>
        ) : null}
        <span className="plugins-chips">
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onRestart}
          >
            {t("plugins.crash.restartNow")}
          </button>
          <button type="button" className="button button--ghost button--small" onClick={onLog}>
            {t("plugins.crash.openLog")}
          </button>
        </span>
      </div>
    </div>
  );
}

function Overview({ plugin, now }: { plugin: PluginDetail; now: number }) {
  const { t, language } = useI18n();
  const process = plugin.process;
  const time = new Intl.DateTimeFormat(language, { dateStyle: "short", timeStyle: "medium" });
  return (
    <div className="plugin-grid">
      <section className="plugins-card" aria-label={t("plugins.details.grants")}>
        <div className="plugins-card__head">
          <div className="plugins-card__title">
            <h3>{t("plugins.details.grants")}</h3>
          </div>
        </div>
        <div className="plugins-card__body">
          <dl className="plugin-defs">
            <dt>{t("plugins.details.network")}</dt>
            <dd>
              {plugin.permissions.length === 0 ? (
                t("plugins.permission.none")
              ) : (
                <span className="plugins-stack">
                  {plugin.permissions.map((line) => (
                    <span key={JSON.stringify(line)}>{permissionText(t, line)}</span>
                  ))}
                </span>
              )}
            </dd>
            <dt>{t("plugins.details.secrets")}</dt>
            <dd>{t("plugins.details.secretsText")}</dd>
            <dt>{t("plugins.details.files")}</dt>
            <dd>{t("plugins.details.filesText")}</dd>
            <dt>{t("plugins.details.shapes")}</dt>
            <dd>{plugin.shapes.join(", ")}</dd>
            <dt>{t("plugins.details.platforms")}</dt>
            <dd>{plugin.platforms.join(", ")}</dd>
          </dl>
          <p className="plugins-note">
            <Icon name="help" />
            <span>{t("plugins.details.networkNote")}</span>
          </p>
          {plugin.approved ? null : (
            <p className="plugins-hint">{t("plugins.details.notApproved")}</p>
          )}
        </div>
      </section>
      <section className="plugins-card" aria-label={t("plugins.details.state")}>
        <div className="plugins-card__head">
          <div className="plugins-card__title">
            <h3>{t("plugins.details.state")}</h3>
          </div>
        </div>
        <div className="plugins-card__body">
          {process === undefined ? (
            <p className="plugins-hint">{t("plugins.details.noProcess")}</p>
          ) : (
            <dl className="plugin-defs">
              <dt>{t("plugins.details.process")}</dt>
              <dd>
                <PluginStatusLabel plugin={plugin} now={now} />
              </dd>
              {process.pid === undefined ? null : (
                <>
                  <dt>{t("plugins.details.pid")}</dt>
                  <dd className="plugins-mono">{process.pid}</dd>
                </>
              )}
              {process.startedAt === undefined ? null : (
                <>
                  <dt>{t("plugins.details.startedAt")}</dt>
                  <dd>{time.format(process.startedAt)}</dd>
                </>
              )}
              <dt>{t("plugins.details.starts")}</dt>
              <dd>{process.starts}</dd>
              <dt>{t("plugins.details.failures")}</dt>
              <dd>{process.failures}</dd>
              {process.lastError === undefined ? null : (
                <>
                  <dt>{t("plugins.details.lastError")}</dt>
                  <dd>
                    {pluginReasonText(t, {
                      reason: process.lastError.reason,
                      fallback: process.lastError.message,
                    })}{" "}
                    <span className="plugins-muted plugins-small">
                      {time.format(process.lastError.at)}
                    </span>
                  </dd>
                </>
              )}
            </dl>
          )}
          <h4 className="plugin-dialog__heading">{t("plugins.details.sandbox")}</h4>
          {process === undefined || process.sandbox.length === 0 ? (
            <p className="plugins-hint">{t("plugins.details.sandboxUnknown")}</p>
          ) : (
            <ul className="plugins-chips" aria-label={t("plugins.details.sandboxOn")}>
              {process.sandbox.map((layer) => (
                <li key={layer} className="plugins-chip plugins-chip--strong">
                  <Icon name="check" />
                  {layerText(t, layer)}
                </li>
              ))}
            </ul>
          )}
          {process === undefined || process.sandboxMissing.length === 0 ? null : (
            <>
              <p className="plugins-hint">{t("plugins.details.sandboxMissing")}</p>
              <ul className="plugins-chips" aria-label={t("plugins.details.sandboxMissing")}>
                {process.sandboxMissing.map((layer) => (
                  <li key={layer} className="plugins-chip">
                    {layerText(t, layer)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {plugin.sandboxWarning === undefined ? null : (
            <p
              className={
                plugin.sandboxWarning === "landlock_missing"
                  ? "plugins-note plugins-note--danger"
                  : "plugins-note plugins-note--warning"
              }
            >
              <Icon name="alert" />
              <span>
                {plugin.sandboxWarning === "landlock_missing"
                  ? pluginReasonText(t, { reason: "plugin.landlock_missing" })
                  : t("plugins.sandbox.withoutLandlock")}
              </span>
            </p>
          )}
          {(process?.warnings ?? [])
            .filter(
              (w) =>
                !(w.reason === "plugin.without_landlock" && plugin.sandboxWarning !== undefined),
            )
            .map((w) => (
              <p
                key={`${w.reason}-${w.params.path ?? ""}`}
                className="plugins-note plugins-note--warning"
              >
                <Icon name="alert" />
                <span>
                  {pluginReasonText(t, { reason: w.reason, params: w.params, fallback: w.message })}
                </span>
              </p>
            ))}
        </div>
      </section>
    </div>
  );
}

function LogCard({ plugin }: { plugin: Plugin }) {
  const { t, language } = useI18n();
  const [only, setOnly] = useState<"all" | "stderr">("all");
  const logs = useQuery({
    queryKey: pluginKeys.logs(plugin.id),
    queryFn: ({ signal }) => pluginLogs(plugin.id, signal),
  });
  const time = new Intl.DateTimeFormat(language, { timeStyle: "medium" });
  const lines = (logs.data?.lines ?? []).filter(
    (line) => only === "all" || line.stream === "stderr",
  );
  const errors = (logs.data?.lines ?? []).filter((line) => line.stream === "stderr").length;

  function download() {
    const text = (logs.data?.lines ?? [])
      .map((line) => `${new Date(line.at).toISOString()} ${line.stream} ${line.text}`)
      .join("\n");
    const url = URL.createObjectURL(new Blob([`${text}\n`], { type: "text/plain" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${plugin.id}.log`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <section className="plugins-card" aria-label={t("plugins.details.tab.log")}>
      <div className="plugins-card__head">
        <div className="plugins-card__title">
          <h3>{t("plugins.log.title")}</h3>
          <p className="plugins-hint">{t("plugins.log.lead")}</p>
        </div>
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form group */}
        <div className="plugins-filters__group" role="group" aria-label={t("plugins.log.show")}>
          <button
            type="button"
            className="plugins-filter"
            aria-pressed={only === "all"}
            onClick={() => setOnly("all")}
          >
            {t("plugins.log.all")}
          </button>
          <button
            type="button"
            className="plugins-filter"
            aria-pressed={only === "stderr"}
            onClick={() => setOnly("stderr")}
          >
            {t("plugins.log.stderr")} <span className="plugins__count">{errors}</span>
          </button>
        </div>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => void logs.refetch()}
        >
          <Icon name="refresh" />
          {t("plugins.log.refresh")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={(logs.data?.lines.length ?? 0) === 0}
          onClick={download}
        >
          <Icon name="download" />
          {t("plugins.log.download")}
        </button>
      </div>
      {logs.data === undefined ? (
        <div className="plugins-card__body">
          <LoadState error={logs.error} onRetry={() => void logs.refetch()} />
        </div>
      ) : lines.length === 0 ? (
        <div className="plugins-card__body">
          <p className="plugins-hint">
            {plugin.running ? t("plugins.log.empty") : t("plugins.log.notRunning")}
          </p>
        </div>
      ) : (
        // biome-ignore lint/a11y/noNoninteractiveTabindex: a scrolling region must be reachable by keyboard
        <ol className="plugin-log" tabIndex={0} aria-label={t("plugins.log.lines")}>
          {lines.map((line, index) => (
            // Lines have no id of their own; the order is fixed between refreshes.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            <li key={index} className="plugin-log__line" data-stream={line.stream}>
              <span className="plugin-log__time">{time.format(line.at)}</span>
              <span className="plugin-log__stream">{line.stream}</span>
              <span className="plugin-log__text">{line.text}</span>
            </li>
          ))}
        </ol>
      )}
      {logs.data === undefined || logs.data.dropped === 0 ? null : (
        <div className="plugins-card__body">
          <p className="plugins-hint">{t("plugins.log.dropped", { count: logs.data.dropped })}</p>
        </div>
      )}
      <div className="plugins-card__body">
        <p className="plugins-hint">{t("plugins.log.network")}</p>
      </div>
    </section>
  );
}

function UsedList({ plugin }: { plugin: PluginDetail }) {
  const org = useCurrentOrg();
  return (
    <ul className="plugin-used">
      {plugin.usedIn.map((source) => (
        <li key={source.id}>
          {org?.id === source.orgId ? (
            <Link to="/data-sources/$datasourceId" params={{ datasourceId: source.id }}>
              {source.name}
            </Link>
          ) : (
            <span>{source.name}</span>
          )}
          <span className="plugins-muted">{source.orgName}</span>
        </li>
      ))}
    </ul>
  );
}

/** Approving the permissions of the installed version, or of the update that waits. */
function ApproveDialog({ plugin, onClose }: { plugin: Plugin; onClose: () => void }) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [granted, setGranted] = useState(false);
  const [tried, setTried] = useState(false);
  const pending = plugin.pending;
  const version = pending?.version ?? plugin.version;
  const grants: Grant[] =
    pending === undefined
      ? plugin.permissions.map((line) => ({ line, change: "first" }))
      : pending.permissions.map((line) => ({
          line,
          change: pending.addedPermissions.some((added) => sameLine(added, line)) ? "new" : "same",
        }));
  const approve = useMutation({
    mutationFn: () => approvePlugin(plugin.id, version),
    onSuccess: (answer) => {
      refreshPlugins(queryClient);
      showToast({ message: t("plugins.details.approved", { name: answer.name, version }) });
      onClose();
    },
  });
  return (
    <Dialog
      open
      title={t("plugins.details.approveTitle", { name: plugin.name, version })}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--primary"
            aria-disabled={approve.isPending}
            onClick={() => {
              setTried(true);
              if (!approve.isPending && granted) approve.mutate();
            }}
          >
            {t("plugins.details.approveConfirm")}
          </button>
        </>
      }
    >
      <div className="plugin-dialog">
        {pending === undefined ? null : (
          <p className="plugins-hint">
            {t("plugins.details.approveUpdateText", {
              version: plugin.version,
              signer: pending.keyId === undefined ? "" : groupedKeyId(pending.keyId),
            })}
          </p>
        )}
        {grants.length === 0 ? (
          <p className="plugins-hint">{t("plugins.permission.none")}</p>
        ) : (
          <ul className="plugin-grants">
            {grants.map((grant) => (
              <li
                key={JSON.stringify(grant.line)}
                className="plugin-grants__item"
                data-new={grant.change === "new"}
              >
                <span className="plugin-grants__target">{permissionText(t, grant.line)}</span>
                {grant.change === "first" ? null : (
                  <span
                    className={
                      grant.change === "new" ? "plugins-chip plugins-chip--strong" : "plugins-chip"
                    }
                  >
                    {grant.change === "new"
                      ? t("plugins.grant.new", { version })
                      : t("plugins.grant.same")}
                  </span>
                )}
              </li>
            ))}
          </ul>
        )}
        <p className="plugins-hint">{t("plugins.install.grantsText")}</p>
        <label className="plugin-check">
          <input
            type="checkbox"
            checked={granted}
            aria-invalid={tried && !granted}
            onChange={(event) => setGranted(event.currentTarget.checked)}
          />
          <span>{t("plugins.install.grant")}</span>
        </label>
        {tried && !granted ? (
          <p className="field__error" role="alert">
            {t("plugins.install.grantFirst")}
          </p>
        ) : null}
        {approve.error === null ? null : (
          <p className="plugins-note plugins-note--danger" role="alert">
            <Icon name="alert" />
            <span>{errorMessage(t, approve.error)}</span>
          </p>
        )}
      </div>
    </Dialog>
  );
}
