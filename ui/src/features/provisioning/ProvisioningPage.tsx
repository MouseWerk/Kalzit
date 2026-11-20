import { useQuery } from "@tanstack/react-query";
import { Link, type LinkProps } from "@tanstack/react-router";
import { useState } from "react";
import type { Provisioned, ResourceKind } from "../../api/generated/shapes";
import { FigureTile, FigureTiles } from "../../components/FigureTile";
import { Icon } from "../../components/Icon";
import { Select } from "../../components/Select";
import { STACK_ROLES } from "../../components/stackTable";
import { GUIDE_URL } from "../../help/docs";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { withBase } from "../../lib/basePath";
import { zoneOption } from "../../lib/timeSettings";
import { type AuditEvent, listAudit } from "../admin/api";
import { LoadState, Section } from "../admin/components/Section";
import { allowedWhen, useAdminAccess } from "../admin/sections";
import { PROVISIONING_KEY, provisionedQuery } from "./api";
import { UnlockDialog } from "./ManagedBadge";
import "../admin/admin.css";
import "./provisioning.css";

const KINDS: readonly ResourceKind[] = ["dashboard", "datasource", "role", "alertRule"];

const KIND_NAME: Record<ResourceKind, MessageKey> = {
  dashboard: "provisioning.kind.dashboard",
  datasource: "provisioning.kind.datasource",
  role: "provisioning.kind.role",
  alertRule: "provisioning.kind.alertRule",
};

const KIND_COUNT: Record<ResourceKind, readonly [one: MessageKey, many: MessageKey]> = {
  dashboard: ["provisioning.count.dashboard", "provisioning.count.dashboards"],
  datasource: ["provisioning.count.datasource", "provisioning.count.datasources"],
  role: ["provisioning.count.role", "provisioning.count.roles"],
  alertRule: ["provisioning.count.alertRule", "provisioning.count.alertRules"],
};

/** Where a managed resource opens. */
function resourceLink(record: Provisioned): LinkProps {
  switch (record.kind) {
    case "dashboard":
      return {
        to: "/dashboards/$dashboardId",
        params: { dashboardId: record.resourceId },
        search: {},
      };
    case "datasource":
      return { to: "/data-sources/$datasourceId", params: { datasourceId: record.resourceId } };
    case "role":
      return { to: "/admin/roles/$roleId", params: { roleId: record.resourceId } };
    case "alertRule":
      return { to: "/alerting/rules/$ruleId", params: { ruleId: record.resourceId } };
  }
}

type DriftKind = "unlocked" | "missing" | "drifted";

/** How a record differs from its file, if it does; unlocked first, as the admin did that. */
export function driftOf(record: Provisioned): DriftKind | null {
  if (record.unlockedAt !== null) return "unlocked";
  if (record.missing) return "missing";
  return record.drifted ? "drifted" : null;
}

const DRIFT_LABEL: Record<DriftKind, MessageKey> = {
  unlocked: "provisioning.drift.unlocked",
  missing: "provisioning.drift.missing",
  drifted: "provisioning.drift.drifted",
};

const DRIFT_TEXT: Record<DriftKind, MessageKey> = {
  unlocked: "provisioning.drift.unlockedText",
  missing: "provisioning.drift.missingText",
  drifted: "provisioning.drift.driftedText",
};

// The stacked list drops the table display: the row header keeps its role on its own.
const ROW_HEADER = { role: "rowheader" } as const;

/**
 * How many characters at the end of a path always stay in view. They fit the narrowest chip of
 * the list (--size-card-min in the monospace font), so the end never runs out of it.
 */
export const PATH_TAIL = 16;

/**
 * A file path in two parts for one line with the ellipsis in the middle: the start is cut, the
 * end stays. The end is the whole file name when it has at most PATH_TAIL characters, otherwise
 * the last PATH_TAIL characters of the path. Characters are counted as code points, so a
 * character outside the basic plane is never cut in half. The text reads whole for screen
 * readers and copying, and the full path is its tooltip.
 */
export function splitPath(path: string): [head: string, tail: string] {
  const slash = path.lastIndexOf("/");
  const name = path.slice(slash + 1);
  if (slash >= 0 && Array.from(name).length <= PATH_TAIL) {
    return [path.slice(0, slash + 1), name];
  }
  const chars = Array.from(path);
  const cut = Math.max(0, chars.length - PATH_TAIL);
  return [chars.slice(0, cut).join(""), chars.slice(cut).join("")];
}

function FilePath({ path }: { path: string }) {
  const [head, tail] = splitPath(path);
  return (
    <code className="managed__path prov-path" title={path}>
      {head === "" ? null : <span className="prov-path__head">{head}</span>}
      <span className="prov-path__tail">{tail}</span>
    </code>
  );
}

function count(summary: Record<string, unknown>, name: string): number {
  const value = summary[name];
  return typeof value === "number" ? value : 0;
}

/**
 * "Verwaltung > Provisioning" (board Provisioning.dc.html, frame 7): what the organization's
 * files manage, when a set was applied last and where the server differs from the files. Sets
 * are applied with `kalzit provision apply`, never here.
 */
export function ProvisioningPage() {
  const { t, language, timeZone } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const allowed = access.has("provisioning:read");
  const canAudit = access.has("audit:read");
  const records = useQuery({ ...provisionedQuery(orgId), enabled: orgId !== "" && allowed });
  // The applies are the audit log's entries; rejected ones change nothing and leave none.
  const applies = useQuery({
    queryKey: [PROVISIONING_KEY, orgId, "applies"],
    queryFn: ({ signal }) =>
      listAudit(orgId, { action: "provisioning.applied" }, undefined, { limit: 20, signal }),
    enabled: orgId !== "" && allowed && canAudit,
  });
  const [set, setSet] = useState("all");
  const [unlocking, setUnlocking] = useState<Provisioned | null>(null);
  const clock = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const list = records.data ?? [];
  const sets = [...new Set(list.map((record) => record.set))].sort();
  // The set applied last: the tile names it, the filter of the list below names them all.
  const latestSet = list.reduce<Provisioned | undefined>(
    (latest, record) =>
      latest === undefined || record.appliedAt > latest.appliedAt ? record : latest,
    undefined,
  )?.set;
  const drift = list.filter((record) => driftOf(record) !== null);
  const last = list.reduce((latest, record) => Math.max(latest, record.appliedAt), 0);
  const shown = list
    .filter((record) => set === "all" || record.set === set)
    .sort(
      (a, b) =>
        KINDS.indexOf(a.kind) - KINDS.indexOf(b.kind) || a.name.localeCompare(b.name, language),
    );
  const named = (record: Provisioned) =>
    record.name === "" ? t("provisioning.list.gone") : record.name;
  const guide = `${GUIDE_URL}${language === "de" ? "de/" : ""}provisioning.md`;
  // The address the command line reaches this server under, for the first commands to copy.
  const server = new URL(withBase("/"), window.location.origin).href.replace(/\/$/, "");

  return (
    <Section
      title="admin.provisioning.title"
      lead="admin.provisioning.lead"
      allowed={allowedWhen(access, allowed)}
      actions={
        <a
          className="button button--secondary"
          href={guide}
          target="_blank"
          rel="noopener noreferrer"
        >
          {t("provisioning.guide")}
          <Icon name="external" />
        </a>
      }
    >
      {records.data === undefined ? (
        <LoadState error={records.error} onRetry={() => void records.refetch()} />
      ) : list.length === 0 ? (
        <section className="prov-empty" aria-labelledby="prov-empty-title">
          <div className="empty-state__icon">
            <Icon name="file" />
          </div>
          <h2 className="empty-state__title" id="prov-empty-title">
            {t("provisioning.empty.title")}
          </h2>
          <p className="empty-state__text">{t("provisioning.empty.text")}</p>
          <pre className="prov-code">
            <code>
              {`kalzit provision export ./kalzit-config --server ${server} --org ${orgId}
kalzit provision plan ./kalzit-config --server ${server}`}
            </code>
          </pre>
          <p className="prov-tip">{t("provisioning.empty.tip")}</p>
        </section>
      ) : (
        <>
          <FigureTiles className="prov-stats">
            <FigureTile
              label={t("provisioning.stats.sets")}
              value={sets.length}
              note={
                latestSet === undefined ? undefined : (
                  <span className="prov-stats__latest truncate" title={latestSet}>
                    {t("provisioning.stats.setsLast", { name: latestSet })}
                  </span>
                )
              }
            />
            <FigureTile
              label={t("provisioning.stats.resources")}
              value={list.length}
              note={KINDS.map((kind) => ({
                kind,
                count: list.filter((record) => record.kind === kind).length,
              }))
                .filter((entry) => entry.count > 0)
                .map((entry) =>
                  t(KIND_COUNT[entry.kind][entry.count === 1 ? 0 : 1], { count: entry.count }),
                )
                .join(", ")}
            />
            <FigureTile
              label={t("provisioning.stats.last")}
              value={clock.format(last)}
              note={t("provisioning.stats.lastNote")}
              small
            />
            <FigureTile
              label={t("provisioning.stats.drift")}
              value={drift.length}
              note={
                drift.length === 0
                  ? t("provisioning.stats.driftNone")
                  : t("provisioning.stats.driftNote")
              }
            />
          </FigureTiles>

          {drift.length === 0 ? null : (
            <section className="prov-block" aria-labelledby="prov-drift">
              <div className="prov-block__head">
                <h2 id="prov-drift">{t("provisioning.drift.title")}</h2>
                <span className="prov-block__note">{t("provisioning.drift.lead")}</span>
              </div>
              <ul className="prov-drift">
                {drift.map((record) => {
                  const kind = driftOf(record) ?? "drifted";
                  return (
                    <li key={`${record.kind}:${record.uid}`} className="prov-drift__item">
                      <span className="admin-badge">{t(DRIFT_LABEL[kind])}</span>
                      <div className="prov-drift__text">
                        <span className="prov-drift__name">
                          {t(KIND_NAME[record.kind])}{" "}
                          {t("provisioning.quoted", { name: named(record) })}
                        </span>
                        <span className="prov-drift__detail">
                          {t(DRIFT_TEXT[kind], {
                            date: record.unlockedAt === null ? "" : clock.format(record.unlockedAt),
                          })}{" "}
                          <code className="managed__path">{record.path}</code>
                        </span>
                      </div>
                      {record.missing ? null : (
                        <Link
                          {...resourceLink(record)}
                          className="button button--ghost button--small"
                        >
                          {t("provisioning.open")}
                        </Link>
                      )}
                    </li>
                  );
                })}
              </ul>
            </section>
          )}

          {canAudit ? (
            <section className="prov-block" aria-labelledby="prov-applies">
              <div className="prov-block__head">
                <h2 id="prov-applies">{t("provisioning.applies.title")}</h2>
                <span className="prov-block__note">{t("provisioning.applies.lead")}</span>
              </div>
              {applies.data === undefined ? (
                <LoadState error={applies.error} onRetry={() => void applies.refetch()} />
              ) : applies.data.items.length === 0 ? (
                <p className="prov-block__empty">{t("provisioning.applies.none")}</p>
              ) : (
                <div className="admin-table-card">
                  <table className="admin-table">
                    <thead>
                      <tr>
                        <th scope="col">{t("provisioning.applies.time")}</th>
                        <th scope="col">{t("provisioning.applies.by")}</th>
                        <th scope="col">{t("provisioning.fact.set")}</th>
                        <th scope="col">{t("provisioning.applies.changes")}</th>
                        <th scope="col">{t("provisioning.applies.result")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {applies.data.items.map((event: AuditEvent) => {
                        const s = event.summary;
                        const adds = count(s, "create") + count(s, "adopt");
                        return (
                          <tr key={event.id}>
                            <td className="prov-nowrap">{clock.format(event.createdAt)}</td>
                            <td>{event.actorName ?? "–"}</td>
                            <td>{typeof s.set === "string" ? s.set : "–"}</td>
                            <td className="prov-changes">
                              <span
                                title={t("provisioning.applies.changesTitle", {
                                  added: adds,
                                  changed: count(s, "update"),
                                  removed: count(s, "delete"),
                                })}
                              >
                                +{adds} ~{count(s, "update")} −{count(s, "delete")}
                              </span>
                            </td>
                            <td>
                              {t(
                                s.prune === true
                                  ? "provisioning.applies.appliedPrune"
                                  : "provisioning.applies.applied",
                              )}
                              {count(s, "drifted") > 0
                                ? ` · ${t("provisioning.applies.overwrote", { count: count(s, "drifted") })}`
                                : ""}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          ) : null}

          <section className="prov-block" aria-labelledby="prov-resources">
            <div className="prov-block__head">
              <h2 id="prov-resources">{t("provisioning.list.title")}</h2>
              {sets.length > 1 ? (
                <Select value={set} aria-label={t("provisioning.fact.set")} onChange={setSet}>
                  <option value="all">{t("provisioning.list.allSets")}</option>
                  {sets.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </Select>
              ) : null}
            </div>
            <div className="admin-table-card prov-resources-card">
              <table className="admin-table prov-resources" {...STACK_ROLES.table}>
                <thead {...STACK_ROLES.rowgroup}>
                  <tr {...STACK_ROLES.row}>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      {t("provisioning.list.resource")}
                    </th>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      {t("provisioning.list.kind")}
                    </th>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      {t("provisioning.list.file")}
                    </th>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      {t("provisioning.fact.applied")}
                    </th>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      {t("provisioning.list.state")}
                    </th>
                    <th scope="col" {...STACK_ROLES.columnheader}>
                      <span className="visually-hidden">{t("provisioning.list.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody {...STACK_ROLES.rowgroup}>
                  {shown.map((record) => {
                    const state = driftOf(record);
                    return (
                      <tr key={`${record.kind}:${record.uid}`} {...STACK_ROLES.row}>
                        <th scope="row" className="prov-name" {...ROW_HEADER}>
                          {record.missing ? (
                            named(record)
                          ) : (
                            <Link {...resourceLink(record)}>{named(record)}</Link>
                          )}
                          {sets.length > 1 ? (
                            <span className="prov-name__set">{record.set}</span>
                          ) : null}
                        </th>
                        <td data-label={t("provisioning.list.kind")} {...STACK_ROLES.cell}>
                          {t(KIND_NAME[record.kind])}
                        </td>
                        <td
                          className="prov-file"
                          data-label={t("provisioning.list.file")}
                          {...STACK_ROLES.cell}
                        >
                          <FilePath path={record.path} />
                        </td>
                        <td
                          className="prov-nowrap prov-applied"
                          data-label={t("provisioning.fact.applied")}
                          {...STACK_ROLES.cell}
                        >
                          {clock.format(record.appliedAt)}
                        </td>
                        <td
                          className="prov-state"
                          data-label={t("provisioning.list.state")}
                          {...STACK_ROLES.cell}
                        >
                          {state === null ? (
                            t("provisioning.list.inSync")
                          ) : (
                            <span className="admin-badge">{t(DRIFT_LABEL[state])}</span>
                          )}
                        </td>
                        <td className="prov-actions" {...STACK_ROLES.cell}>
                          {state === null && access.has("provisioning:write") ? (
                            <button
                              type="button"
                              className="button button--ghost button--small"
                              aria-label={t("provisioning.unlock.buttonNamed", {
                                name: named(record),
                              })}
                              onClick={() => setUnlocking(record)}
                            >
                              {t("provisioning.unlock.button")}
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="prov-footnote">{t("provisioning.list.footnote")}</p>
          </section>
        </>
      )}
      {unlocking === null ? null : (
        <UnlockDialog
          record={unlocking}
          name={named(unlocking)}
          onClose={() => setUnlocking(null)}
        />
      )}
    </Section>
  );
}
