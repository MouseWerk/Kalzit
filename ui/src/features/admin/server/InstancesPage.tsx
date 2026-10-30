import { useQuery } from "@tanstack/react-query";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { formatDateTime } from "../components/format";
import { LoadState, Section } from "../components/Section";
import { allowedWhen, useAdminAccess } from "../sections";
import { type ClusterView, getInstances, type Instance, instanceKeys } from "./instancesApi";
import "./updates.css";
import "./instances.css";

/** The page asks again this often, so heartbeats and a change of leader show without a reload. */
const REFRESH_MS = 5000;

const TRANSPORT_TEXT: Record<ClusterView["transport"], MessageKey> = {
  notify: "admin.instances.transport.notify",
  poll: "admin.instances.transport.poll",
  none: "admin.instances.transport.none",
};

/**
 * Instances: the Kalzit servers on this database, which one leads (runs the jobs that must run
 * once) and how changes reach them. Read only; servers join by starting on the same PostgreSQL
 * database. Only server admins open it; the server checks every request on its own.
 */
export function InstancesPage() {
  const access = useAdminAccess();
  const list = useQuery({
    queryKey: instanceKeys.list,
    queryFn: getInstances,
    enabled: access.isServerAdmin,
    refetchInterval: REFRESH_MS,
  });
  const data = list.data;
  return (
    <Section
      title="admin.instances.title"
      lead="admin.instances.lead"
      allowed={allowedWhen(access, access.isServerAdmin)}
    >
      {data === undefined ? (
        <LoadState error={list.error} onRetry={() => void list.refetch()} />
      ) : (
        <div className="updates">
          <Strip data={data} />
          <Table data={data} />
          <Hints data={data} />
        </div>
      )}
    </Section>
  );
}

function Strip({ data }: { data: ClusterView }) {
  const { t, language, timeZone } = useI18n();
  const leader = data.instances.find((i) => i.leader);
  const alive = data.instances.filter((i) => i.alive).length;
  return (
    <section className="updates-card updates-strip" aria-label={t("admin.instances.summary")}>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.instances.mode")}</span>
        <div className="updates-strip__value">
          <span className="updates-strong">
            {t(
              data.mode === "cluster"
                ? "admin.instances.mode.cluster"
                : "admin.instances.mode.single",
            )}
          </span>
        </div>
        <div className="updates-muted updates-strip__meta">
          {t("admin.instances.running", { count: alive })}
        </div>
      </div>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.instances.database")}</span>
        <div className="updates-strip__value">
          <span className="updates-strong">
            {data.database === "postgres" ? "PostgreSQL" : "SQLite"}
          </span>
        </div>
        <div className="updates-muted updates-strip__meta">
          {t(
            data.database === "postgres"
              ? "admin.instances.database.postgres"
              : "admin.instances.database.sqlite",
          )}
        </div>
      </div>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.instances.leader")}</span>
        <div className="updates-strip__value">
          <span className="updates-strong">{leader?.host ?? t("admin.instances.leader.none")}</span>
        </div>
        <div className="updates-muted updates-strip__meta">
          {data.leaderSince === null
            ? t("admin.instances.leader.lease", { secs: data.leaseSecs })
            : t("admin.instances.leader.since", {
                date: formatDateTime(data.leaderSince, language, timeZone),
              })}
        </div>
      </div>
      <div className="updates-strip__cell">
        <span className="updates-caps">{t("admin.instances.transport")}</span>
        <div className="updates-strip__value">
          <span className="updates-strong">{t(TRANSPORT_TEXT[data.transport])}</span>
        </div>
        <div className="updates-muted updates-strip__meta">
          {t("admin.instances.heartbeat", { secs: data.heartbeatSecs })}
        </div>
      </div>
    </section>
  );
}

function state(instance: Instance): MessageKey {
  if (instance.stoppedAt !== null) {
    return "admin.instances.state.stopped";
  }
  return instance.alive ? "admin.instances.state.running" : "admin.instances.state.silent";
}

function Table({ data }: { data: ClusterView }) {
  const { t, language, timeZone } = useI18n();
  return (
    <section className="updates-card" aria-label={t("admin.instances.list")}>
      <div className="instances__head">
        <h2 className="updates-section-title">{t("admin.instances.list")}</h2>
        <span className="updates-muted">
          {t("admin.instances.count", { count: data.instances.length })}
        </span>
      </div>
      <div className="updates-table-wrap">
        <table className="updates-table">
          <thead>
            <tr>
              <th scope="col">{t("admin.instances.col.server")}</th>
              <th scope="col">{t("admin.instances.col.version")}</th>
              <th scope="col">{t("admin.instances.col.address")}</th>
              <th scope="col">{t("admin.instances.col.started")}</th>
              <th scope="col">{t("admin.instances.col.heartbeat")}</th>
              <th scope="col">{t("admin.instances.col.state")}</th>
            </tr>
          </thead>
          <tbody>
            {data.instances.map((instance) => (
              <tr key={instance.id} className={instance.alive ? undefined : "instances__row--gone"}>
                <td>
                  <div className="instances__server">
                    <span className="updates-strong">{instance.host}</span>
                    {instance.leader ? (
                      <span className="admin-badge">{t("admin.instances.badge.leader")}</span>
                    ) : null}
                    {instance.current ? (
                      <span className="admin-badge">{t("admin.instances.badge.current")}</span>
                    ) : null}
                  </div>
                  <div className="updates-mono updates-muted" title={instance.id}>
                    {instance.id.slice(0, 8)}
                  </div>
                </td>
                <td className="updates-mono">{instance.version}</td>
                <td className="updates-mono">{instance.address}</td>
                <td>{formatDateTime(instance.startedAt, language, timeZone)}</td>
                <td>{formatDateTime(instance.heartbeatAt, language, timeZone)}</td>
                <td>
                  <span className={instance.alive ? "updates-ok" : "updates-muted"}>
                    {t(state(instance))}
                  </span>
                  {instance.stoppedAt === null ? null : (
                    <div className="updates-muted">
                      {formatDateTime(instance.stoppedAt, language, timeZone)}
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function Hints({ data }: { data: ClusterView }) {
  const { t } = useI18n();
  const versions = new Set(data.instances.filter((i) => i.alive).map((i) => i.version));
  return (
    <>
      {versions.size > 1 ? (
        <p className="updates-hint" role="status">
          {t("admin.instances.hint.versions", { versions: [...versions].join(", ") })}
        </p>
      ) : null}
      <p className="updates-hint">
        {t(
          data.database === "postgres"
            ? "admin.instances.hint.postgres"
            : "admin.instances.hint.sqlite",
        )}
      </p>
    </>
  );
}
