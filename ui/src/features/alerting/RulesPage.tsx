import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearch } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Icon } from "../../components/Icon";
import { PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { ConfirmDialog } from "../admin/components/Dialog";
import { datasourcesQuery } from "../datasources/api";
import { KindMark } from "../datasources/kindMarks";
import {
  ALERTING_KEY,
  type AlertState,
  alertingSourcesQuery,
  deleteRule,
  type Instance,
  type Rule,
  ruleQuery,
  rulesQuery,
  setRulePaused,
} from "./api";
import { alertingErrorText, evalErrorText } from "./reasons";
import type { RulesSearch } from "./routes";
import {
  conditionText,
  durationText,
  formatNumber,
  labelPairs,
  reduceText,
  STATE_ORDER,
  scheduleText,
  sortRules,
} from "./ruleModel";
import {
  AlertingLayout,
  LabelChips,
  StateLabel,
  useAgo,
  useAlerting,
  useAlertTime,
} from "./shared";

type Filter = AlertState | "paused" | "all";
const FILTERS: readonly Filter[] = ["all", ...STATE_ORDER, "paused"];

function matchesFilter(rule: Rule, filter: Filter): boolean {
  if (filter === "all") return true;
  if (filter === "paused") return rule.paused;
  return !rule.paused && rule.state === filter;
}

/**
 * "Alerting > Regeln" (board Alerting.dc.html, frames 1 to 3): the rules of the organization with
 * their state, shape, condition and interval, sorted by state and name; a rule opens to its
 * instances. Filters by state (toggle buttons), text and shape; the row menu holds the actions.
 */
export function RulesPage() {
  const { t, language } = useI18n();
  const search = useSearch({ from: "/_app/alerting" }) as RulesSearch;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, permissions, status, canWrite } = useAlerting();
  const readable = permissions.has("alerts:read");
  const rules = useQuery({ ...rulesQuery(orgId), enabled: readable && orgId !== "" });
  const sources = useQuery({ ...datasourcesQuery(orgId), enabled: orgId !== "" });
  const optedIn = useQuery({ ...alertingSourcesQuery(orgId), enabled: readable && orgId !== "" });
  const [text, setText] = useState("");
  const [shape, setShape] = useState("all");
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const [deleting, setDeleting] = useState<Rule | null>(null);
  const filter: Filter = search.state ?? "all";

  const remove = useMutation({
    mutationFn: (rule: Rule) => deleteRule(orgId, rule.id),
    onSuccess: async (_, rule) => {
      setDeleting(null);
      showToast({ message: t("alerting.rules.deleted", { name: rule.name }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
    },
  });
  const pause = useMutation({
    mutationFn: ({ rule, paused }: { rule: Rule; paused: boolean }) =>
      setRulePaused(orgId, rule.id, paused),
    onSuccess: async (saved) => {
      showToast({
        message: t(saved.paused ? "alerting.rules.paused" : "alerting.rules.resumed", {
          name: saved.name,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
    },
    onError: (error) => showToast({ message: alertingErrorText(t, error), error: true }),
  });

  const all = rules.data ?? [];
  const sourceOf = new Map((sources.data ?? []).map((source) => [source.id, source]));
  const needle = text.trim().toLowerCase();
  const shown = sortRules(
    all.filter(
      (rule) =>
        matchesFilter(rule, filter) &&
        (search.source === undefined || rule.datasourceId === search.source) &&
        (shape === "all" || rule.reduce.shape === shape) &&
        (needle === "" ||
          rule.name.toLowerCase().includes(needle) ||
          labelPairs(rule.labels).some((pair) => pair.toLowerCase().includes(needle))),
    ),
  );
  const count = (f: Filter) => all.filter((rule) => matchesFilter(rule, f)).length;
  const lead = t("alerting.rules.lead");

  function toggle(id: string) {
    const next = new Set(open);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setOpen(next);
  }

  const actions = canWrite ? (
    <PageActions>
      <Link to="/alerting/silences" search={{ create: true }} className="button button--secondary">
        <Icon name="bellOff" />
        {t("alerting.silences.add")}
      </Link>
      <Link to="/alerting/rules/new" search={{}} className="button button--primary">
        <Icon name="plus" />
        {t("alerting.rules.add")}
      </Link>
    </PageActions>
  ) : null;

  if (rules.isSuccess && all.length === 0) {
    return (
      <AlertingLayout tab="rules" lead={lead} actions={actions}>
        <section className="alert-card alert-empty" aria-labelledby="alert-empty-title">
          <h2 id="alert-empty-title" className="alert-empty__title">
            {t("alerting.empty.title")}
          </h2>
          <p className="alert-muted">{t("alerting.empty.text")}</p>
          <ol className="alert-empty__steps">
            <li>{t("alerting.empty.step1")}</li>
            <li>{t("alerting.empty.step2")}</li>
            <li>{t("alerting.empty.step3")}</li>
          </ol>
          {canWrite ? (
            <div className="alert-row-actions">
              <Link to="/alerting/rules/new" search={{}} className="button button--primary">
                <Icon name="plus" />
                {t("alerting.rules.add")}
              </Link>
            </div>
          ) : null}
          {optedIn.data !== undefined && optedIn.data.length === 0 ? (
            <p className="alert-note">
              {t("alerting.empty.noSource")}{" "}
              <Link to="/data-sources" search={{}}>
                {t("alerting.empty.toSources")}
              </Link>
            </p>
          ) : null}
        </section>
      </AlertingLayout>
    );
  }

  return (
    <AlertingLayout tab="rules" lead={lead} actions={actions}>
      <div className="alert-toolbar">
        {/* biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's field set */}
        <div className="alert-filters" role="group" aria-label={t("alerting.rules.filterState")}>
          {FILTERS.map((f) => (
            <button
              key={f}
              type="button"
              className="alert-filter"
              aria-pressed={filter === f}
              onClick={() =>
                void navigate({
                  to: "/alerting",
                  search: { ...search, state: f === "all" ? undefined : f },
                })
              }
            >
              {f === "all" ? t("alerting.rules.filterAll") : <StateLabel state={f} quiet />}
              <span className="tabs__count">{count(f)}</span>
            </button>
          ))}
        </div>
        <label className="alert-search">
          <Icon name="search" />
          <span className="visually-hidden">{t("alerting.rules.search")}</span>
          <input
            type="search"
            className="input"
            placeholder={t("alerting.rules.search")}
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </label>
        <Select
          value={shape}
          onChange={setShape}
          aria-label={t("alerting.rules.shapeFilter")}
          className="alert-shape-filter"
        >
          <option value="all">{t("alerting.rules.allShapes")}</option>
          <option value="frame">frame</option>
          <option value="documents">documents</option>
          <option value="graph">graph</option>
        </Select>
      </div>
      {search.source === undefined ? null : (
        <p className="alert-note">
          {t("alerting.rules.onSource", { name: sourceOf.get(search.source)?.name ?? "" })}{" "}
          <Link to="/alerting" search={{ ...search, source: undefined }}>
            {t("alerting.rules.allSources")}
          </Link>
        </p>
      )}
      {rules.isError ? <p className="field__error">{alertingErrorText(t, rules.error)}</p> : null}
      <div className="alert-card alert-table-wrap">
        <table className="alert-table">
          <thead>
            <tr>
              <th scope="col">
                <span className="visually-hidden">{t("alerting.rules.column.expand")}</span>
              </th>
              <th scope="col">{t("alerting.rules.column.state")}</th>
              <th scope="col">{t("alerting.rules.column.rule")}</th>
              <th scope="col">{t("alerting.rules.column.source")}</th>
              <th scope="col">{t("alerting.rules.column.shape")}</th>
              <th scope="col">{t("alerting.rules.column.condition")}</th>
              <th scope="col">{t("alerting.rules.column.interval")}</th>
              <th scope="col" className="alert-num">
                {t("alerting.rules.column.contactPoints")}
              </th>
              <th scope="col">{t("alerting.rules.column.evaluated")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("alerting.rules.column.actions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((rule) => {
              const expanded = open.has(rule.id);
              const source = sourceOf.get(rule.datasourceId);
              return (
                <Fragment key={rule.id}>
                  <tr className={expanded ? "alert-table__open" : undefined}>
                    <td>
                      <button
                        type="button"
                        className="button button--ghost button--small alert-expand"
                        aria-expanded={expanded}
                        aria-label={t("alerting.rules.instancesOf", { name: rule.name })}
                        title={t("alerting.rules.instances")}
                        onClick={() => toggle(rule.id)}
                      >
                        <Icon name="chevron" />
                      </button>
                    </td>
                    <td>
                      <RuleState rule={rule} />
                    </td>
                    <td>
                      <Link
                        to="/alerting/rules/$ruleId"
                        params={{ ruleId: rule.id }}
                        className="alert-rule-name"
                      >
                        {rule.name}
                      </Link>
                      <LabelChips labels={rule.labels} />
                    </td>
                    <td>
                      {source === undefined ? (
                        <span className="alert-muted">–</span>
                      ) : (
                        <span className="alert-source">
                          <KindMark kind={source.kind} small name={source.name} />
                          {source.name}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="alert-chip alert-chip--mono">{rule.reduce.shape}</span>
                    </td>
                    <td className="alert-mono-cell">
                      {reduceText(t, rule.reduce)} {conditionText(t, rule.condition, language)}
                    </td>
                    <td>{scheduleText(t, rule.intervalSecs, rule.forSecs)}</td>
                    <td className="alert-num">{rule.contactPointIds.length}</td>
                    <td>
                      <Evaluated rule={rule} />
                    </td>
                    <td>
                      <RuleMenu
                        rule={rule}
                        canWrite={canWrite}
                        onPause={(paused) => pause.mutate({ rule, paused })}
                        onDelete={() => setDeleting(rule)}
                      />
                    </td>
                  </tr>
                  {expanded ? (
                    <tr className="alert-table__sub">
                      <td />
                      <td colSpan={9}>
                        <Instances orgId={orgId} rule={rule} canWrite={canWrite} />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              );
            })}
          </tbody>
        </table>
        {rules.isSuccess && shown.length === 0 ? (
          <p className="alert-muted alert-pad">{t("alerting.rules.noMatch")}</p>
        ) : null}
      </div>
      <p className="alert-hint">
        {t(canWrite ? "alerting.rules.footer" : "alerting.rules.footerReadOnly")}
      </p>
      <ConfirmDialog
        open={deleting !== null}
        title={t("alerting.rules.deleteTitle", { name: deleting?.name ?? "" })}
        confirmLabel={t("alerting.rules.delete")}
        busy={remove.isPending}
        error={remove.isError ? alertingErrorText(t, remove.error) : null}
        onConfirm={() => deleting !== null && remove.mutate(deleting)}
        onClose={() => {
          setDeleting(null);
          remove.reset();
        }}
      >
        <p>
          {t("alerting.rules.deleteText", {
            count: Object.values(deleting?.instanceCounts ?? {}).reduce((a, b) => a + (b ?? 0), 0),
            days: status?.limits.historyRetentionDays ?? 90,
          })}
        </p>
        <p className="alert-muted">{t("alerting.rules.deleteHint")}</p>
      </ConfirmDialog>
    </AlertingLayout>
  );
}

/** The rule's state with the line under it: how many series fire, or since when. */
function RuleState({ rule }: { rule: Rule }) {
  const { t } = useI18n();
  if (rule.paused) {
    return <StateLabel state="paused" />;
  }
  if (rule.state === null) {
    return <span className="alert-muted">{t("alerting.rules.notEvaluated")}</span>;
  }
  const total = Object.values(rule.instanceCounts).reduce((a, b) => a + (b ?? 0), 0);
  const firing = rule.instanceCounts.firing ?? 0;
  return (
    <span className="alert-state-cell">
      <StateLabel state={rule.state} />
      {total > 1 && firing > 0 ? (
        <span className="alert-sub">{t("alerting.rules.seriesFiring", { firing, total })}</span>
      ) : null}
    </span>
  );
}

function Evaluated({ rule }: { rule: Rule }) {
  const { t } = useI18n();
  const ago = useAgo();
  if (rule.paused) {
    return (
      <span className="alert-muted">
        {t("alerting.rules.pausedBy", { name: rule.updatedByName ?? "" })}
      </span>
    );
  }
  if (rule.lastEvaluatedAt === null) {
    return <span className="alert-muted">–</span>;
  }
  return (
    <span className="alert-state-cell">
      <span>{ago(rule.lastEvaluatedAt)}</span>
      {rule.lastError === null ? null : (
        <span className="alert-sub alert-sub--warn">{evalErrorText(t, rule.lastError)}</span>
      )}
      {rule.skippedEvaluations > 0 ? (
        <span className="alert-sub">
          {t("alerting.rules.skipped", { count: rule.skippedEvaluations })}
        </span>
      ) : null}
    </span>
  );
}

function RuleMenu({
  rule,
  canWrite,
  onPause,
  onDelete,
}: {
  rule: Rule;
  canWrite: boolean;
  onPause: (paused: boolean) => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const entries: ToolbarMenuEntry[] = [];
  if (canWrite) {
    entries.push(
      {
        key: "edit",
        label: t("alerting.rules.menu.edit"),
        icon: "edit",
        onSelect: () =>
          void navigate({ to: "/alerting/rules/$ruleId", params: { ruleId: rule.id } }),
      },
      {
        key: "duplicate",
        label: t("alerting.rules.menu.duplicate"),
        icon: "copy",
        onSelect: () => void navigate({ to: "/alerting/rules/new", search: { from: rule.id } }),
      },
      {
        key: "silence",
        label: t("alerting.rules.menu.silence"),
        icon: "bellOff",
        onSelect: () => void navigate({ to: "/alerting/silences", search: { rule: rule.id } }),
      },
      {
        key: "pause",
        label: t(rule.paused ? "alerting.rules.menu.resume" : "alerting.rules.menu.pause"),
        onSelect: () => onPause(!rule.paused),
      },
    );
  } else {
    entries.push({
      key: "open",
      label: t("alerting.rules.menu.open"),
      icon: "eye",
      onSelect: () => void navigate({ to: "/alerting/rules/$ruleId", params: { ruleId: rule.id } }),
    });
  }
  entries.push({
    key: "history",
    label: t("alerting.rules.menu.history"),
    icon: "history",
    onSelect: () => void navigate({ to: "/alerting/history", search: { rule: rule.id } }),
  });
  if (rule.dashboardId !== null) {
    const dashboardId = rule.dashboardId;
    entries.push({
      key: "panel",
      label: t("alerting.rules.menu.panel"),
      icon: "dashboards",
      onSelect: () =>
        void navigate({
          to: "/dashboards/$dashboardId",
          params: { dashboardId },
          search: rule.panelId === null ? {} : { viewPanel: rule.panelId },
        }),
    });
  }
  if (canWrite) {
    entries.push(
      { kind: "separator", key: "sep" },
      {
        key: "delete",
        label: t("alerting.rules.menu.delete"),
        icon: "trash",
        danger: true,
        onSelect: onDelete,
      },
    );
  }
  return (
    <ToolbarMenu
      label={t("alerting.rules.menu.label", { name: rule.name })}
      icon="more"
      entries={entries}
    />
  );
}

/** The instances of an opened rule: one row per series with its value, since when, and silencing. */
function Instances({ orgId, rule, canWrite }: { orgId: string; rule: Rule; canWrite: boolean }) {
  const { t, language } = useI18n();
  const detail = useQuery(ruleQuery(orgId, rule.id));
  const time = useAlertTime();
  if (detail.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (detail.isError) {
    return <p className="field__error">{alertingErrorText(t, detail.error)}</p>;
  }
  const instances = [...(detail.data.instances ?? [])].sort(
    (a, b) => STATE_ORDER.indexOf(a.state) - STATE_ORDER.indexOf(b.state),
  );
  if (instances.length === 0) {
    return (
      <p className="alert-muted">
        {t(rule.paused ? "alerting.rules.noInstancesPaused" : "alerting.rules.noInstances")}
      </p>
    );
  }
  return (
    <ul
      className="alert-instances"
      aria-label={t("alerting.rules.instancesOf", { name: rule.name })}
    >
      {instances.map((instance) => (
        <li key={instance.fingerprint} className="alert-instance">
          <StateLabel
            state={
              instance.silencedBy.length > 0 && instance.state === "firing"
                ? "silenced"
                : instance.state
            }
          />
          <LabelChips labels={instance.labels} />
          <span className="alert-mono-cell">
            {instance.lastError !== null
              ? evalErrorText(t, instance.lastError)
              : instance.lastValue === null
                ? "–"
                : `${rule.reduce.shape === "frame" ? `${rule.reduce.function} ` : ""}${formatNumber(instance.lastValue, language)} · ${t("alerting.rules.conditionShort", { condition: conditionText(t, rule.condition, language) })}`}
          </span>
          <span className="alert-muted">{sinceText(t, instance, rule, time)}</span>
          {canWrite ? (
            <Link
              to="/alerting/silences"
              search={{ rule: rule.id, fingerprint: instance.fingerprint }}
              className="button button--ghost button--small"
              aria-label={t("alerting.rules.silenceInstance", {
                labels: labelPairs(instance.labels).join(", ") || rule.name,
              })}
            >
              <Icon name="bellOff" />
              {t("alerting.rules.silence")}
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function sinceText(
  t: ReturnType<typeof useI18n>["t"],
  instance: Instance,
  rule: Rule,
  time: (ms: number) => string,
): string {
  if (instance.state === "pending" && instance.pendingSince !== null) {
    return t("alerting.rules.pendingUntil", {
      since: time(instance.pendingSince),
      at: time(instance.pendingSince + rule.forSecs * 1000),
    });
  }
  const minutes = Math.max(0, Math.round((Date.now() - instance.stateSince) / 60_000));
  return instance.state === "ok"
    ? t("alerting.rules.since", { since: time(instance.stateSince) })
    : t("alerting.rules.sinceFor", {
        since: time(instance.stateSince),
        duration: durationText(t, Math.max(60, minutes * 60)),
      });
}
