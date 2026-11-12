import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { Select } from "../../components/Select";
import { type Translate, useI18n } from "../../i18n/i18n";
import type { ContactKind, ContactPoint, Rule } from "./api";
import { checkRoutes, policyKeys } from "./policies";
import {
  blockedBy,
  EACH_INSTANCE,
  effectiveContactPoints,
  effectiveValue,
  findNode,
  type Policy,
  type PolicyMatcher,
  type PolicyNode,
  pathOf,
  policyMatches,
  routesFor,
  shortDuration,
  walk,
} from "./policyModel";
import { alertingErrorText } from "./reasons";
import { labelPairs } from "./ruleModel";
import { Segmented } from "./shared";

/**
 * Pieces the policy pages, the rule editor and the rules list share: a contact point as a chip,
 * a way as "Standard › Lager › Lager kritisch", the times with inherited ones as a word, and the
 * route checker ("Weg prüfen").
 */

const KIND_LETTER: Record<ContactKind, string> = {
  mail: "M",
  webhook: "W",
  slack: "S",
  teams: "T",
};

/** A contact point with its kind as a letter; never recipients or URLs. */
export function ContactChip({ point }: { point: ContactPoint | undefined }) {
  const { t } = useI18n();
  if (point === undefined) {
    return <span className="alert-chip">{t("alerting.policies.unknownContact")}</span>;
  }
  return (
    <span className="alert-chip" title={t(`alerting.contact.kind.${point.kind}`)}>
      <span className="alert-kind" aria-hidden="true">
        {KIND_LETTER[point.kind]}
      </span>
      {point.name}
      <span className="visually-hidden">({t(`alerting.contact.kind.${point.kind}`)})</span>
    </span>
  );
}

export function ContactChips({
  ids,
  points,
}: {
  ids: readonly string[];
  points: readonly ContactPoint[];
}) {
  return (
    <span className="alert-labels">
      {ids.map((id) => (
        <ContactChip key={id} point={points.find((point) => point.id === id)} />
      ))}
    </span>
  );
}

export function matcherText(matcher: PolicyMatcher): string {
  return `${matcher.label} ${matcher.op} ${matcher.value}`;
}

export function MatcherChips({ matchers }: { matchers: readonly PolicyMatcher[] }) {
  return (
    <span className="alert-labels">
      {matchers.map((matcher) => (
        <span key={matcherText(matcher)} className="alert-chip alert-chip--mono" translate="no">
          {matcherText(matcher)}
        </span>
      ))}
    </span>
  );
}

/** "Standard › Lager › Lager kritisch". */
export function wayText(node: PolicyNode): string {
  return pathOf(node)
    .map((policy) => policy.name)
    .join(" › ");
}

export function WayText({ node }: { node: PolicyNode }) {
  const path = pathOf(node);
  return (
    <span className="alert-way">
      {path.map((policy, index) => (
        <span key={policy.id}>
          {index === 0 ? null : (
            <span className="alert-way__sep" aria-hidden="true">
              {" › "}
            </span>
          )}
          {index === 0 ? null : <span className="visually-hidden">, </span>}
          {policy.name}
        </span>
      ))}
    </span>
  );
}

/** A duration in the tree's short form; 0 for the repeat is "aus". */
export function timeText(t: Translate, secs: number, repeat = false): string {
  return repeat && secs === 0 ? t("alerting.policies.off") : shortDuration(secs);
}

export function groupByText(t: Translate, groupBy: readonly string[]): string {
  if (groupBy.length === 0) return t("alerting.policies.group.all");
  if (groupBy.length === 1 && groupBy[0] === EACH_INSTANCE)
    return t("alerting.policies.group.each");
  return groupBy.join(", ");
}

/** The three times of a node as they apply: "30 s · 5 min · 4 h". */
export function effectiveTimesText(t: Translate, node: PolicyNode): string {
  return [
    timeText(t, effectiveValue(node, "groupWaitSecs").value),
    timeText(t, effectiveValue(node, "groupIntervalSecs").value),
    timeText(t, effectiveValue(node, "repeatIntervalSecs").value, true),
  ].join(" · ");
}

/** The three times as the tree shows them: own values, inherited ones as the word "geerbt". */
export function OwnTimes({ policy }: { policy: Policy }) {
  const { t } = useI18n();
  const parts: [number | null, boolean][] = [
    [policy.groupWaitSecs, false],
    [policy.groupIntervalSecs, false],
    [policy.repeatIntervalSecs, true],
  ];
  return (
    <span className="alert-times">
      {parts.map(([value, repeat], index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: three fixed parts
        <span key={index}>
          {index === 0 ? null : " · "}
          {value === null ? (
            <span className="alert-inherited">{t("alerting.policies.inherited")}</span>
          ) : (
            timeText(t, value, repeat)
          )}
        </span>
      ))}
    </span>
  );
}

/** What a way delivers: contact points, group, times, escalation. */
export function WayFacts({ node, points }: { node: PolicyNode; points: readonly ContactPoint[] }) {
  const { t } = useI18n();
  const contacts = effectiveContactPoints(node).value;
  const steps = node.policy.escalations;
  return (
    <dl className="alert-facts">
      <dt>{t("alerting.policies.column.contactPoints")}</dt>
      <dd>
        {contacts.length === 0 ? (
          <span className="alert-warn-text">{t("alerting.policies.notDelivered")}</span>
        ) : (
          <ContactChips ids={contacts} points={points} />
        )}
      </dd>
      <dt>{t("alerting.policies.facts.group")}</dt>
      <dd>{groupByText(t, effectiveValue(node, "groupBy").value)}</dd>
      <dt>{t("alerting.policies.facts.times")}</dt>
      <dd>{effectiveTimesText(t, node)}</dd>
      {steps.length === 0 ? null : (
        <>
          <dt>{t("alerting.policies.facts.escalation")}</dt>
          <dd>
            {steps
              .map((step) =>
                t("alerting.policies.facts.step", {
                  after: shortDuration(step.waitSecs),
                  names: step.contactPointIds
                    .map((id) => points.find((point) => point.id === id)?.name ?? "–")
                    .join(", "),
                }),
              )
              .join(" · ")}
          </dd>
        </>
      )}
    </dl>
  );
}

/** "key=value" pairs from free text, one per line or separated by commas. */
export function parseLabelText(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of text.split(/[\n,]+/)) {
    const at = part.indexOf("=");
    if (at <= 0) continue;
    const key = part.slice(0, at).trim();
    if (key !== "") out[key] = part.slice(at + 1).trim();
  }
  return out;
}

/** An instance's labels as the tree sees them: the rule's, the instance's and the rule name. */
export function routingLabels(
  rule: Pick<Rule, "name" | "labels">,
  instance: Readonly<Record<string, string>> = {},
): Record<string, string> {
  return { ...rule.labels, ...instance, alertname: rule.name };
}

/** Why a policy whose own conditions hold is not reached: an earlier sibling stops the search. */
function blockedNotes(
  root: PolicyNode,
  routes: readonly PolicyNode[],
  labels: Readonly<Record<string, string>>,
): { policy: Policy; by: Policy }[] {
  const onWay = new Set<string>();
  for (const end of routes) for (const policy of pathOf(end)) onWay.add(policy.id);
  const out: { policy: Policy; by: Policy }[] = [];
  for (const node of walk(root)) {
    if (node.parent === null || onWay.has(node.policy.id) || !onWay.has(node.parent.policy.id)) {
      continue;
    }
    if (!policyMatches(node.policy, labels)) continue;
    const by = blockedBy(node, labels);
    if (by !== null) out.push({ policy: node.policy, by });
  }
  return out;
}

/** The ways of one set of labels, as cards. */
export function Ways({
  root,
  labels,
  points,
  ends,
}: {
  root: PolicyNode;
  labels: Readonly<Record<string, string>>;
  points: readonly ContactPoint[];
  /** The ways as the server answered them; without, they are found in the tree here. */
  ends?: readonly string[];
}) {
  const { t } = useI18n();
  const routes =
    ends === undefined
      ? routesFor(root, labels)
      : ends.flatMap((id) => {
          const node = findNode(root, id);
          return node === undefined ? [] : [node];
        });
  const notes = blockedNotes(root, routes, labels);
  return (
    <div className="alert-ways">
      <p className="alert-overline">
        {t("alerting.policies.check.ways", { count: routes.length })}
      </p>
      {routes.map((node) => (
        <section key={node.policy.id} className="alert-way-card">
          <p className="alert-way-card__head">
            <WayText node={node} />
            {node.policy.continue ? (
              <span className="alert-chip">{t("alerting.policies.continue")}</span>
            ) : null}
          </p>
          <WayFacts node={node} points={points} />
        </section>
      ))}
      {notes.map((note) => (
        <p key={note.policy.id} className="alert-hint">
          {t("alerting.policies.check.blocked", { name: note.policy.name, by: note.by.name })}
        </p>
      ))}
    </div>
  );
}

/**
 * "Weg prüfen" (board frame 1): labels typed in, or a rule with its instances, and the ways they
 * take with contact points and times. Everyone who sees the tree may use it.
 */
export function RouteChecker({
  orgId,
  root,
  points,
  rules,
  id,
}: {
  orgId: string;
  root: PolicyNode;
  points: readonly ContactPoint[];
  rules: readonly Rule[];
  id?: string;
}) {
  const { t } = useI18n();
  const ids = useId();
  const [mode, setMode] = useState<"labels" | "rule">("labels");
  const [text, setText] = useState("");
  const [ruleId, setRuleId] = useState("");
  const chosen = rules.find((rule) => rule.id === ruleId);
  // A stored rule's instances are checked on the server, which has their labels.
  const checked = useQuery({
    queryKey: [...policyKeys.list(orgId), "route", ruleId],
    queryFn: ({ signal }) => checkRoutes(orgId, { ruleId }, signal),
    enabled: chosen !== undefined,
  });
  const labels = parseLabelText(text);
  return (
    <section
      className="alert-card alert-pad alert-checker"
      aria-labelledby={`${ids}-title`}
      id={id}
      tabIndex={-1}
    >
      <header className="alert-preview__head">
        <h2 className="alert-step__title" id={`${ids}-title`}>
          {t("alerting.policies.check.title")}
        </h2>
        <Segmented
          label={t("alerting.policies.check.mode")}
          value={mode}
          options={[
            { value: "labels", label: t("alerting.policies.check.labels") },
            { value: "rule", label: t("alerting.policies.check.rule") },
          ]}
          onChange={(value) => setMode(value === "rule" ? "rule" : "labels")}
        />
      </header>
      <div className="alert-checker__body">
        <div className="alert-checker__input">
          {mode === "labels" ? (
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-labels`}>
                {t("alerting.policies.check.labels")}
              </label>
              <textarea
                id={`${ids}-labels`}
                className="input input--mono alert-textarea"
                rows={5}
                spellCheck={false}
                value={text}
                placeholder={t("alerting.policies.check.placeholder")}
                aria-describedby={`${ids}-labels-hint`}
                onChange={(event) => setText(event.target.value)}
              />
              <p className="field__hint" id={`${ids}-labels-hint`}>
                {t("alerting.policies.check.labelsHint")}
              </p>
            </div>
          ) : (
            <div className="field">
              <label className="field__label" htmlFor={`${ids}-rule`}>
                {t("alerting.policies.check.rule")}
              </label>
              <Select id={`${ids}-rule`} value={ruleId} onChange={(value) => setRuleId(value)}>
                <option value="">{t("alerting.policies.check.pickRule")}</option>
                {rules.map((rule) => (
                  <option key={rule.id} value={rule.id}>
                    {rule.name}
                  </option>
                ))}
              </Select>
              <p className="field__hint">{t("alerting.policies.check.ruleHint")}</p>
            </div>
          )}
        </div>
        <div className="alert-checker__result" aria-live="polite">
          {mode === "labels" ? (
            Object.keys(labels).length === 0 ? (
              <p className="alert-hint">{t("alerting.policies.check.empty")}</p>
            ) : (
              <Ways root={root} labels={labels} points={points} />
            )
          ) : chosen === undefined ? (
            <p className="alert-hint">{t("alerting.policies.check.emptyRule")}</p>
          ) : checked.isError ? (
            <p className="field__error">{alertingErrorText(t, checked.error)}</p>
          ) : (
            <>
              {chosen.routing === "direct" ? (
                <p className="alert-note">{t("alerting.policies.check.direct")}</p>
              ) : null}
              {(checked.data ?? []).map((item) => (
                <div
                  key={item.fingerprint ?? labelPairs(item.labels).join(",")}
                  className="alert-checker__instance"
                >
                  <p className="alert-mono-cell">{labelPairs(item.labels).join(", ")}</p>
                  <Ways
                    root={root}
                    labels={item.labels}
                    points={points}
                    ends={item.routes.map((route) => route.policyId)}
                  />
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
