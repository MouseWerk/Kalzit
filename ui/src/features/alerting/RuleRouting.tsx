import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useI18n } from "../../i18n/i18n";
import type { ContactPoint, PreviewInstance, Rule, RuleRoute } from "./api";
import { checkRoutes, policyKeys } from "./policies";
import { ContactChips, timeText } from "./policyParts";
import { alertingErrorText } from "./reasons";
import { labelPairs, type RuleDraft } from "./ruleModel";

/**
 * Where a rule goes (board AlertingRouting.dc.html, frame 9): the ways of the instances from
 * "Jetzt auswerten" through the policies, or, for a direct rule, where it would go after
 * switching. Asked of the server's route check, with the rule's labels and `alertname`.
 */

/** The labels the policies see for the draft: its own labels, an instance's, and its name. */
export function draftLabels(
  draft: RuleDraft,
  instance: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const own = Object.fromEntries(
    draft.labels.filter((row) => row.key.trim() !== "").map((row) => [row.key.trim(), row.value]),
  );
  return { ...own, ...instance, alertname: draft.name.trim() };
}

function useRouteCheck(orgId: string, sets: Record<string, string>[], enabled: boolean) {
  const key = JSON.stringify(sets);
  return useQuery({
    queryKey: [...policyKeys.list(orgId), "route-labels", key],
    queryFn: ({ signal }) => checkRoutes(orgId, { labels: sets }, signal),
    enabled: enabled && orgId !== "" && sets.length > 0,
    staleTime: 10_000,
  });
}

/** The ways of the draft's instances, as a table: instance, way, contact points. */
export function PolicyRoutes({
  orgId,
  draft,
  instances,
  points,
  canContacts,
}: {
  orgId: string;
  draft: RuleDraft;
  instances: readonly PreviewInstance[] | undefined;
  points: readonly ContactPoint[];
  canContacts: boolean;
}) {
  const { t } = useI18n();
  const sets =
    instances === undefined || instances.length === 0
      ? [draftLabels(draft)]
      : instances.slice(0, 100).map((instance) => draftLabels(draft, instance.labels));
  const check = useRouteCheck(orgId, sets, draft.name.trim() !== "");
  const repeat = check.data?.[0]?.routes[0]?.repeatIntervalSecs;
  return (
    <div className="field">
      <span className="field__label">
        {t(
          instances === undefined
            ? "alerting.routing.tableLabels"
            : "alerting.routing.tableInstances",
        )}
      </span>
      {draft.name.trim() === "" ? (
        <p className="alert-hint">{t("alerting.routing.nameFirst")}</p>
      ) : check.isError ? (
        <p className="field__error">{alertingErrorText(t, check.error)}</p>
      ) : (
        <div className="alert-table-wrap">
          <table className="alert-table alert-table--compact">
            <thead>
              <tr>
                <th scope="col">{t("alerting.preview.instance")}</th>
                <th scope="col">{t("alerting.routing.way")}</th>
                <th scope="col">{t("alerting.routing.to")}</th>
              </tr>
            </thead>
            <tbody>
              {(check.data ?? []).map((item, index) => {
                const own = instances?.[index]?.labels ?? {};
                return (
                  <tr key={labelPairs(item.labels).join(",")}>
                    <td className="alert-mono-cell">
                      {labelPairs(own).join(", ") || t("alerting.preview.wholeRule")}
                    </td>
                    <td>
                      {item.routes.map((route) => (
                        <span key={route.policyId} className="alert-way">
                          {route.path.map((step) => step.name).join(" › ")}
                        </span>
                      ))}
                    </td>
                    <td>
                      {item.routes.map((route) =>
                        route.delivers ? (
                          <ContactChips
                            key={route.policyId}
                            ids={route.contactPointIds}
                            points={points}
                          />
                        ) : (
                          <span key={route.policyId} className="alert-warn-text">
                            {t("alerting.policies.notDelivered")}
                          </span>
                        ),
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="alert-hint">
        {repeat === undefined
          ? t("alerting.routing.reminderHidden")
          : t("alerting.routing.reminderHiddenValue", { value: timeText(t, repeat, true) })}{" "}
        <Link to="/alerting/policies">{t("alerting.policies.check.title")}</Link>
        {canContacts && draft.name.trim() !== "" ? (
          <>
            {" · "}
            <Link to="/alerting/policies/new" search={{ alertname: draft.name.trim() }}>
              {t("alerting.routing.ownPolicy")}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}

/** A direct rule: where it would go through the policies, and the switch. */
export function DirectNote({
  orgId,
  draft,
  points,
  readOnly,
  onSwitch,
}: {
  orgId: string;
  draft: RuleDraft;
  points: readonly ContactPoint[];
  readOnly: boolean;
  onSwitch: () => void;
}) {
  const { t } = useI18n();
  const check = useRouteCheck(orgId, [draftLabels(draft)], draft.name.trim() !== "");
  const routes = check.data?.[0]?.routes ?? [];
  const names = [...new Set(routes.flatMap((route) => route.contactPointIds))]
    .map((id) => points.find((point) => point.id === id)?.name ?? "–")
    .join(", ");
  return (
    <div className="alert-note alert-note--row">
      <span>
        {routes.length === 0
          ? t("alerting.routing.direct")
          : t("alerting.routing.directWould", {
              names: names === "" ? t("alerting.policies.notDelivered") : names,
              way: routes
                .map((route) => route.path.map((step) => step.name).join(" › "))
                .join("; "),
            })}
      </span>
      {readOnly ? null : (
        <button type="button" className="button button--secondary button--small" onClick={onSwitch}>
          {t("alerting.routing.switch")}
        </button>
      )}
    </div>
  );
}

/** The column "Weg" of the rules list: the first way, "+1 Weg", "Direkt", or not delivered. */
export function RouteCell({ rule }: { rule: Rule }) {
  const { t } = useI18n();
  if (rule.routing === "direct") {
    return (
      <span className="alert-way">
        {t("alerting.routing.directShort")}{" "}
        <span className="alert-muted">
          {rule.contactPointIds.length === 1
            ? t("alerting.routing.contactOne")
            : t("alerting.routing.contacts", { count: rule.contactPointIds.length })}
        </span>
      </span>
    );
  }
  const routes: RuleRoute[] = rule.routes ?? [];
  const first = routes[0];
  if (first === undefined) return <span className="alert-muted">–</span>;
  const more = routes.length - 1;
  return (
    <span
      className="alert-way"
      title={rule.dataHidden ? t("alerting.routing.hiddenWay") : undefined}
    >
      {first.path.map((step) => step.name).join(" › ")}
      {more === 0 ? null : (
        <span className="alert-chip">
          {more === 1 ? t("alerting.routing.moreOne") : t("alerting.routing.more", { count: more })}
        </span>
      )}
      {routes.some((route) => !route.delivers) ? (
        <span className="alert-warn-text"> {t("alerting.policies.notDeliveredShort")}</span>
      ) : null}
      {rule.dataHidden ? (
        <span className="alert-sub">{t("alerting.routing.hiddenWayShort")}</span>
      ) : null}
    </span>
  );
}
