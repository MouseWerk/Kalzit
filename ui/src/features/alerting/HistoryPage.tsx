import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { useState } from "react";
import { Select } from "../../components/Select";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { zoneOption } from "../../lib/timeSettings";
import {
  ALERTING_KEY,
  type AlertState,
  type ContactPoint,
  contactPointsQuery,
  fetchHistory,
  type HistoryEntry,
  type HistoryFilter,
  rulesQuery,
} from "./api";
import { policiesQuery, routingAvailable } from "./policies";
import { deliveryResultText, evalErrorText } from "./reasons";
import type { HistorySearch } from "./routes";
import { formatNumber, labelPairs, STATE_ORDER, timelineRows } from "./ruleModel";
import { AlertingLayout, StateLabel, stateKey, useAlerting } from "./shared";

const RANGES = [1, 6, 24, 24 * 7, 24 * 30] as const;
const RANGE_KEYS: Record<number, MessageKey> = {
  1: "alerting.history.range.hour",
  6: "alerting.history.range.hours6",
  24: "alerting.history.range.day",
  168: "alerting.history.range.week",
  720: "alerting.history.range.month",
};
const PAGE = 200;
const LABEL_FILTER = /^[A-Za-z_][A-Za-z0-9_]*=.+$/;

const EVENT_KEYS: Record<string, MessageKey> = {
  firing: "alerting.history.event.firing",
  resolved: "alerting.history.event.resolved",
  no_data: "alerting.history.event.no_data",
  error: "alerting.history.event.error",
  reminder: "alerting.history.event.reminder",
  test: "alerting.history.event.test",
  escalation: "alerting.history.event.escalation",
};

/**
 * The stage of a group's delivery in words: the change itself, a repetition, an escalation step,
 * or a resolve because the instance's way changed.
 */
export function stageText(t: ReturnType<typeof useI18n>["t"], stage: string): string {
  if (stage === "0") return t("alerting.history.stage.change");
  if (stage === "r") return t("alerting.history.stage.rerouted");
  const step = /^e([1-3])$/.exec(stage);
  if (step !== null) return t("alerting.history.stage.escalation", { level: step[1] ?? "" });
  return /^\d+$/.test(stage)
    ? t("alerting.history.stage.repeat", { count: stage })
    : t("alerting.history.stage.change");
}

/**
 * "Alerting > Verlauf" (board frames 10 and 11): changes of state and deliveries of the
 * organization, filtered by range, rule, state and label; above them a timeline of the states per
 * instance, with the list below as its table view.
 */
export function HistoryPage() {
  const { t, language, timeZone } = useI18n();
  const search = useSearch({ from: "/_app/alerting/history" }) as HistorySearch;
  const navigate = useNavigate();
  const { orgId, status } = useAlerting();
  const hours = search.hours ?? 24;
  const [label, setLabel] = useState(search.label ?? "");
  const [to] = useState(() => Date.now());
  const from = to - hours * 3600_000;
  const rules = useQuery({ ...rulesQuery(orgId), enabled: orgId !== "" });
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: orgId !== "" });
  // A server with policies names the policy of a group's delivery.
  const policies = useQuery({
    ...policiesQuery(orgId),
    enabled: orgId !== "" && routingAvailable(status),
  });
  const policyName = new Map((policies.data ?? []).map((policy) => [policy.id, policy.name]));
  const filter: HistoryFilter = {
    from,
    to,
    limit: PAGE,
    ...(search.rule === undefined ? {} : { ruleId: search.rule }),
    ...(search.state === undefined ? {} : { state: search.state }),
    ...(search.kind === undefined ? {} : { kind: search.kind }),
    ...(search.label === undefined ? {} : { label: search.label }),
  };
  const history = useInfiniteQuery({
    queryKey: [ALERTING_KEY, orgId, "history", filter],
    queryFn: ({ pageParam, signal }) =>
      fetchHistory(orgId, pageParam === "" ? filter : { ...filter, cursor: pageParam }, signal),
    initialPageParam: "",
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled: orgId !== "",
  });
  const entries = history.data?.pages.flatMap((page) => page.items) ?? [];
  const pointName = new Map(
    (points.data ?? []).map((point: ContactPoint) => [point.id, point.name]),
  );
  const zone = zoneOption(timeZone);
  const clock = new Intl.DateTimeFormat(language, { timeStyle: "medium", ...zone });
  const dateClock = new Intl.DateTimeFormat(language, {
    dateStyle: "short",
    timeStyle: "medium",
    ...zone,
  });
  const sameDay = new Intl.DateTimeFormat("en-CA", { dateStyle: "short", ...zone });
  const when = (ms: number) =>
    sameDay.format(ms) === sameDay.format(Date.now()) ? clock.format(ms) : dateClock.format(ms);
  const labelInvalid = label.trim() !== "" && !LABEL_FILTER.test(label.trim());

  function go(patch: Partial<HistorySearch>) {
    void navigate({ to: "/alerting/history", search: { ...search, ...patch } });
  }

  return (
    <AlertingLayout tab="history" lead={t("alerting.history.lead")}>
      <div className="alert-toolbar">
        <Select
          value={String(hours)}
          aria-label={t("alerting.history.rangeLabel")}
          onChange={(value) => go({ hours: Number(value) === 24 ? undefined : Number(value) })}
        >
          {RANGES.map((value) => (
            <option key={value} value={String(value)}>
              {t(RANGE_KEYS[value] ?? "alerting.history.range.day")}
            </option>
          ))}
        </Select>
        <Select
          value={search.rule ?? ""}
          aria-label={t("alerting.history.ruleLabel")}
          onChange={(value) => go({ rule: value === "" ? undefined : value })}
        >
          <option value="">{t("alerting.history.allRules")}</option>
          {(rules.data ?? []).map((rule) => (
            <option key={rule.id} value={rule.id}>
              {rule.name}
            </option>
          ))}
        </Select>
        <Select
          value={search.state ?? ""}
          aria-label={t("alerting.history.stateLabel")}
          onChange={(value) => go({ state: value === "" ? undefined : (value as AlertState) })}
        >
          <option value="">{t("alerting.history.allStates")}</option>
          {STATE_ORDER.map((state) => (
            <option key={state} value={state}>
              {t(stateKey(state))}
            </option>
          ))}
        </Select>
        <Select
          value={search.kind ?? ""}
          aria-label={t("alerting.history.kindLabel")}
          onChange={(value) =>
            go({ kind: value === "transition" || value === "delivery" ? value : undefined })
          }
        >
          <option value="">{t("alerting.history.allKinds")}</option>
          <option value="transition">{t("alerting.history.kind.transition")}</option>
          <option value="delivery">{t("alerting.history.kind.delivery")}</option>
        </Select>
        <form
          className="alert-search"
          onSubmit={(event) => {
            event.preventDefault();
            if (!labelInvalid) go({ label: label.trim() === "" ? undefined : label.trim() });
          }}
        >
          <input
            type="search"
            className="input input--mono"
            value={label}
            placeholder={t("alerting.history.labelPlaceholder")}
            aria-label={t("alerting.history.labelLabel")}
            aria-invalid={labelInvalid || undefined}
            onChange={(event) => setLabel(event.target.value)}
          />
        </form>
        <span className="alert-muted">
          {t("alerting.history.retention", { days: status?.limits.historyRetentionDays ?? 90 })}
        </span>
      </div>
      {labelInvalid ? (
        <p className="field__error" role="alert">
          {t("alerting.reason.alerts.label_filter_invalid")}
        </p>
      ) : null}
      {history.isError ? <p className="field__error">{t("errors.internal")}</p> : null}
      <Timeline entries={entries} from={from} to={to} />
      <div className="alert-card alert-table-wrap">
        <table className="alert-table">
          <caption className="visually-hidden">{t("alerting.history.tableCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("alerting.history.column.time")}</th>
              <th scope="col">{t("alerting.history.column.rule")}</th>
              <th scope="col">{t("alerting.history.column.change")}</th>
              <th scope="col" className="alert-num">
                {t("alerting.history.column.value")}
              </th>
              <th scope="col">{t("alerting.history.column.delivery")}</th>
            </tr>
          </thead>
          <tbody>
            {entries.map((entry) => (
              <tr key={entry.id}>
                <td className="alert-num-left">{when(entry.at)}</td>
                <td>
                  <span className="alert-rule-name">{entry.ruleName}</span>{" "}
                  <span className="alert-mono-cell alert-muted">
                    {entry.dataHidden === true
                      ? t("alerting.dataHidden.labels")
                      : labelPairs(entry.labels).join(", ")}
                  </span>
                </td>
                <td>
                  {entry.reason === "flapping" ? (
                    t("alerting.history.flapping", { count: entry.attempt ?? 1 })
                  ) : entry.kind === "transition" ? (
                    <span className="alert-change">
                      {entry.fromState === null ? null : (
                        <StateLabel state={entry.fromState} quiet />
                      )}
                      <span aria-hidden="true">→</span>
                      <span className="visually-hidden">{t("alerting.history.to")}</span>
                      {entry.toState === null ? null : <StateLabel state={entry.toState} quiet />}
                    </span>
                  ) : (
                    t(EVENT_KEYS[entry.event ?? ""] ?? "alerting.history.event.firing")
                  )}
                </td>
                <td className="alert-num">
                  {entry.value === null ? "" : formatNumber(entry.value, language)}
                </td>
                <td>
                  {detailText(t, entry, pointName)}
                  {entry.kind === "delivery" && entry.policyId != null ? (
                    <span className="alert-sub">
                      {t("alerting.history.viaPolicy", {
                        name: policyName.get(entry.policyId) ?? t("alerting.history.deletedPolicy"),
                        stage: stageText(t, entry.stage ?? "0"),
                      })}
                    </span>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {history.isSuccess && entries.length === 0 ? (
          <p className="alert-muted alert-pad">{t("alerting.history.none")}</p>
        ) : null}
      </div>
      {history.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={history.isFetchingNextPage || undefined}
          onClick={() => !history.isFetchingNextPage && void history.fetchNextPage()}
        >
          {t("alerting.history.more")}
        </button>
      ) : null}
    </AlertingLayout>
  );
}

/** The last column: why it changed (an error, a gone series, a silence) or how a send went. */
function detailText(
  t: ReturnType<typeof useI18n>["t"],
  entry: HistoryEntry,
  pointName: ReadonlyMap<string, string>,
): string {
  if (entry.kind === "delivery") {
    // A group's delivery of hidden data names neither its policy nor the policy's contact point.
    const name =
      entry.contactPointId === null && entry.dataHidden === true
        ? t("alerting.history.hiddenPoint")
        : (pointName.get(entry.contactPointId ?? "") ?? t("alerting.history.deletedPoint"));
    if (entry.result === "ok") {
      return t("alerting.history.delivered", { name });
    }
    // Held back by a limit before any attempt: no attempt number.
    if (entry.result === "rate_limited" || entry.result === "queue_full") {
      return t("alerting.history.deliveryNotSent", {
        name,
        result: deliveryResultText(t, entry.result),
      });
    }
    return t("alerting.history.deliveryFailed", {
      name,
      result: deliveryResultText(t, entry.result ?? "failed"),
      attempt: entry.attempt ?? 1,
    });
  }
  if (entry.error !== null) return evalErrorText(t, entry.error, entry.dataHidden === true);
  if (entry.silenceId !== null) return t("alerting.history.silenced");
  if (entry.reason === "series_gone") return t("alerting.history.seriesGone");
  if (entry.reason === "replaced") return t("alerting.history.replaced");
  if (entry.reason === "rerouted") return t("alerting.history.stage.rerouted");
  return "";
}

function Timeline({
  entries,
  from,
  to,
}: {
  entries: readonly HistoryEntry[];
  from: number;
  to: number;
}) {
  const { t, language, timeZone } = useI18n();
  const rows = timelineRows(entries, from, to).slice(0, 20);
  const clock = new Intl.DateTimeFormat(language, { timeStyle: "short", ...zoneOption(timeZone) });
  if (rows.length === 0) {
    return null;
  }
  const span = to - from;
  return (
    <section className="alert-card alert-pad alert-timeline" aria-labelledby="alert-timeline-title">
      <header className="alert-preview__head">
        <h2 id="alert-timeline-title" className="alert-step__title">
          {t("alerting.history.timeline")}
        </h2>
        <span className="alert-legend" aria-hidden="true">
          {STATE_ORDER.map((state) => (
            <span key={state} className="alert-legend__item">
              <span className="alert-tl-swatch" data-state={state} />
              {t(stateKey(state))}
            </span>
          ))}
        </span>
      </header>
      <ul className="alert-timeline__rows">
        {rows.map((row) => (
          <li key={row.key} className="alert-timeline__row">
            <span className="alert-timeline__name">{row.title}</span>
            <svg
              className="alert-tl"
              viewBox="0 0 1000 10"
              preserveAspectRatio="none"
              aria-hidden="true"
              focusable="false"
            >
              {row.segments.map((segment) => (
                <rect
                  key={`${segment.from}`}
                  className="alert-tl__part"
                  data-state={segment.state}
                  x={((segment.from - from) / span) * 1000}
                  y={0}
                  width={Math.max(((segment.to - segment.from) / span) * 1000, 1)}
                  height={10}
                />
              ))}
            </svg>
            <span className="visually-hidden">
              {row.segments
                .map((segment) =>
                  t("alerting.history.segment", {
                    state: t(stateKey(segment.state)),
                    from: clock.format(segment.from),
                    to: clock.format(segment.to),
                  }),
                )
                .join("; ")}
            </span>
          </li>
        ))}
      </ul>
      <div className="alert-timeline__row" aria-hidden="true">
        <span />
        <div className="alert-timeline__axis">
          {[0, 0.25, 0.5, 0.75].map((share) => (
            <span key={share}>{clock.format(from + share * span)}</span>
          ))}
          <span>{t("alerting.history.now")}</span>
        </div>
      </div>
    </section>
  );
}
