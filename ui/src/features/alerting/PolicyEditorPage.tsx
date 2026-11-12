import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { type ReactNode, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { type Translate, useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { ConfirmDialog } from "../admin/components/Dialog";
import { errorReason } from "../datasources/reasons";
import { ALERTING_KEY, type ContactPoint, contactPointsQuery } from "./api";
import { deleteText } from "./PoliciesPage";
import {
  createPolicy,
  deletePolicy,
  groupsQuery,
  parsePolicy,
  policiesQuery,
  policyLimits,
  routingAvailable,
  updatePolicy,
} from "./policies";
import {
  buildTree,
  draftOf,
  EACH_INSTANCE,
  ESCALATION_CHOICES,
  effectiveContactPoints,
  effectiveValue,
  findNode,
  GROUP_INTERVAL_CHOICES,
  GROUP_WAIT_CHOICES,
  type GroupMode,
  groupByOf,
  inheritedMatchers,
  inputOfPolicy,
  type Policy,
  type PolicyDraft,
  type PolicyErrors,
  type PolicyField,
  type PolicyMatcherOp,
  type PolicyNode,
  REPEAT_CHOICES,
  shortDuration,
  validatePolicy,
} from "./policyModel";
import {
  ContactChip,
  ContactChips,
  groupByText,
  matcherText,
  timeText,
  WayText,
} from "./policyParts";
import { alertingErrorText } from "./reasons";
import type { NewPolicySearch } from "./routes";
import { Segmented, useAlerting, useAlertTime } from "./shared";

const OPS: readonly PolicyMatcherOp[] = ["=", "!=", "=~", "!~"];

/** "Richtlinie" under a parent: empty, a copy of another, or a policy for one rule. */
export function NewPolicyPage() {
  const search = useSearch({ from: "/_app/alerting/policies/new" }) as NewPolicySearch;
  return <PolicyEditorLoader parentId={search.parent} search={search} />;
}

export function EditPolicyPage() {
  const { policyId } = useParams({ from: "/_app/alerting/policies/$policyId" });
  return <PolicyEditorLoader policyId={policyId} />;
}

function PolicyEditorLoader({
  policyId,
  parentId,
  search,
}: {
  policyId?: string;
  parentId?: string | undefined;
  search?: NewPolicySearch;
}) {
  const { t } = useI18n();
  const { orgId, status } = useAlerting();
  const available = routingAvailable(status);
  const policies = useQuery({ ...policiesQuery(orgId), enabled: orgId !== "" && available });
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: orgId !== "" });
  if (status !== undefined && !available) {
    return (
      <Page title={t("alerting.tab.policies")}>
        <EmptyState icon="info" title={t("alerting.policies.missing.title")}>
          {t("alerting.policies.missing.text")}
        </EmptyState>
      </Page>
    );
  }
  if (policies.isPending || points.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  const root = buildTree(policies.data ?? []);
  const node = policyId === undefined ? undefined : findNode(root, policyId);
  const parent = parentId === undefined ? (root ?? undefined) : findNode(root, parentId);
  if (policies.isError || (policyId !== undefined && node === undefined) || parent === undefined) {
    return (
      <Page title={t("alerting.tab.policies")}>
        <EmptyState icon="alert" title={t("alerting.policies.notFound")}>
          {policies.isError ? alertingErrorText(t, policies.error) : null}
        </EmptyState>
      </Page>
    );
  }
  let initial = draftOf(node?.policy ?? null);
  if (node === undefined && search !== undefined) {
    const from = search.from === undefined ? undefined : findNode(root, search.from);
    if (from !== undefined) {
      initial = {
        ...draftOf(from.policy),
        name: t("alerting.editor.copyName", { name: from.policy.name }),
      };
    } else if (search.alertname !== undefined) {
      initial = {
        ...initial,
        name: search.alertname,
        matchers: [{ label: "alertname", op: "=", value: search.alertname }],
        continue: true,
      };
    }
  }
  return (
    <PolicyEditor
      key={
        node === undefined ? `new:${parent.policy.id}` : `${node.policy.id}:${node.policy.version}`
      }
      node={node}
      parent={node === undefined ? parent : node.parent}
      initial={initial}
      points={points.data ?? []}
    />
  );
}

/**
 * One policy (board frame 3): name, conditions with the inherited ones named, contact points,
 * grouping and times with the inherited values, "weiter prüfen" and the escalation steps; on the
 * right how it runs. One explicit save with the version. Read-only without `alerts:contacts`.
 */
function PolicyEditor({
  node,
  parent,
  initial,
  points,
}: {
  node: PolicyNode | undefined;
  parent: PolicyNode | null;
  initial: PolicyDraft;
  points: readonly ContactPoint[];
}) {
  const { t } = useI18n();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, canContacts, status } = useAlerting();
  const time = useAlertTime();
  const limits = policyLimits(status);
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<PolicyErrors>({});
  const [conflict, setConflict] = useState<Policy | null>(null);
  const [deleting, setDeleting] = useState(false);
  const isRoot = node !== undefined && node.parent === null;
  const readOnly = !canContacts;
  const title = node?.policy.name ?? t("alerting.policies.newTitle");
  useDocumentTitle(node === undefined ? "alerting.policies.newTitle" : "alerting.tab.policies");

  // What the policy inherits: from its parent (a new one) or from above itself.
  const above = node === undefined ? parent : node.parent;
  const inherited = {
    groupBy: above === null ? null : effectiveValue(above, "groupBy"),
    groupWaitSecs: above === null ? null : effectiveValue(above, "groupWaitSecs"),
    groupIntervalSecs: above === null ? null : effectiveValue(above, "groupIntervalSecs"),
    repeatIntervalSecs: above === null ? null : effectiveValue(above, "repeatIntervalSecs"),
    contacts: above === null ? null : effectiveContactPoints(above),
  };
  const inheritedConditions = inheritedOf(node, above);
  const siblings = (above?.children ?? []).filter((child) => child !== node);
  const nextSibling =
    node === undefined ? undefined : node.parent?.children[node.parent.children.indexOf(node) + 1];

  const save = useMutation({
    mutationFn: async (overwrite: Policy | null) => {
      const input = inputOfPolicy(draft, isRoot);
      if (node === undefined) return createPolicy(orgId, parent?.policy.id ?? "", input);
      return updatePolicy(orgId, node.policy.id, input, overwrite?.version ?? node.policy.version);
    },
    onSuccess: async (saved) => {
      setConflict(null);
      showToast({ message: t("alerting.policies.saved", { name: saved.name }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
      if (node === undefined) {
        void navigate({ to: "/alerting/policies/$policyId", params: { policyId: saved.id } });
      }
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") && error.current !== undefined) {
        setConflict(parsePolicy(error.current));
      }
    },
  });
  const remove = useMutation({
    mutationFn: async () => {
      if (node !== undefined) await deletePolicy(orgId, node.policy.id);
    },
    onSuccess: async () => {
      showToast({ message: t("alerting.policies.deleted", { name: node?.policy.name ?? "" }) });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
      void navigate({ to: "/alerting/policies" });
    },
  });

  function update(patch: Partial<PolicyDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function submit() {
    const errors = validatePolicy(draft, {
      isRoot,
      siblingNames: siblings.map((sibling) => sibling.policy.name),
      inheritedIntervalSecs: inherited.groupIntervalSecs?.value ?? 300,
      inheritedRepeatSecs: inherited.repeatIntervalSecs?.value ?? 14_400,
      limits,
    });
    setShown(errors);
    const first = Object.keys(errors)[0];
    if (first !== undefined) {
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    save.mutate(null);
  }

  const serverField = save.isError && conflict === null ? policyReasonField(save.error) : undefined;
  const fieldError = (field: PolicyField): string | undefined => {
    const own = shown[field];
    if (own !== undefined) return t(own.key as Parameters<Translate>[0], own.params ?? {});
    if (serverField === field) return alertingErrorText(t, save.error);
    return undefined;
  };
  const formError =
    save.isError && conflict === null && serverField === undefined
      ? alertingErrorText(t, save.error)
      : null;
  const position =
    node?.parent === null
      ? t("alerting.policies.rootWhere")
      : t("alerting.policies.where", {
          parent: above?.policy.name ?? "",
          position:
            node === undefined
              ? (above?.children.length ?? 0) + 1
              : (above?.children.indexOf(node) ?? 0) + 1,
          count:
            node === undefined ? (above?.children.length ?? 0) + 1 : (above?.children.length ?? 1),
        });

  const inheritedText = (secs: number | undefined, repeat = false) =>
    secs === undefined ? "" : timeText(t, secs, repeat);

  return (
    <Page title={title}>
      <Breadcrumbs
        crumbs={[
          { label: t("alerting.title"), link: { to: "/alerting" } },
          { label: t("alerting.tab.policies"), link: { to: "/alerting/policies" } },
          { label: title },
        ]}
      />
      <PageActions>
        {readOnly || node === undefined || isRoot ? null : (
          <button
            type="button"
            className="button button--secondary alert-danger-text"
            onClick={() => setDeleting(true)}
          >
            {t("alerting.policies.menu.delete")}
          </button>
        )}
        <Link to="/alerting/policies" className="button button--secondary">
          {t(readOnly ? "alerting.editor.back" : "alerting.editor.cancel")}
        </Link>
        {readOnly ? null : (
          <button
            type="button"
            className="button button--primary"
            aria-disabled={save.isPending || undefined}
            onClick={() => !save.isPending && submit()}
          >
            {t("alerting.editor.save")}
          </button>
        )}
      </PageActions>
      <div className="alert-editor">
        <div className="alert-editor__form">
          <FormAlert>{formError}</FormAlert>
          {readOnly ? (
            <p className="alert-note">
              <Icon name="lock" />
              <span>{t("alerting.policies.readOnlyDetail")}</span>
            </p>
          ) : null}
          {conflict === null ? null : (
            <div className="notice notice--danger" role="alert">
              <Icon name="alert" />
              <div>
                <p>
                  {t("alerting.policies.conflict", {
                    name: conflict.updatedByName ?? "",
                    version: conflict.version,
                  })}
                </p>
                <div className="alert-row-actions">
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => {
                      setDraft(draftOf(conflict));
                      setConflict(null);
                      save.reset();
                    }}
                  >
                    {t("alerting.editor.conflictLoad")}
                  </button>
                  <button
                    type="button"
                    className="button button--danger button--small"
                    onClick={() => save.mutate(conflict)}
                  >
                    {t("alerting.editor.conflictOverwrite")}
                  </button>
                </div>
              </div>
            </div>
          )}
          <section
            className="alert-card alert-pad alert-head-fields"
            aria-label={t("alerting.editor.general")}
          >
            <Field
              id={`${ids}-name`}
              label={t("alerting.editor.name")}
              error={fieldError("name")}
              hint={position}
            >
              <input
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                maxLength={100}
                readOnly={readOnly || isRoot}
                aria-invalid={fieldError("name") === undefined ? undefined : true}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
          </section>

          <Step number={1} title={t("alerting.policies.step.matchers")}>
            {isRoot ? (
              <p className="alert-muted">{t("alerting.policies.rootMatchesAll")}</p>
            ) : (
              <fieldset
                className="alert-fieldset"
                aria-describedby={
                  fieldError("matchers") === undefined ? undefined : `${ids}-matchers-error`
                }
              >
                <legend className="visually-hidden">{t("alerting.policies.step.matchers")}</legend>
                <div id={`${ids}-matchers`} tabIndex={-1} className="alert-matchers">
                  {draft.matchers.map((matcher, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
                    <div key={index} className="alert-mrow">
                      <input
                        className="input input--mono"
                        value={matcher.label}
                        placeholder={t("alerting.editor.labelKey")}
                        aria-label={t("alerting.policies.matcherLabelOf", { index: index + 1 })}
                        readOnly={readOnly}
                        onChange={(event) =>
                          update({
                            matchers: draft.matchers.map((m, i) =>
                              i === index ? { ...m, label: event.target.value } : m,
                            ),
                          })
                        }
                      />
                      <Select
                        value={matcher.op}
                        disabled={readOnly}
                        aria-label={t("alerting.policies.matcherOpOf", { index: index + 1 })}
                        onChange={(value) =>
                          update({
                            matchers: draft.matchers.map((m, i) =>
                              i === index ? { ...m, op: value as PolicyMatcherOp } : m,
                            ),
                          })
                        }
                      >
                        {OPS.map((op) => (
                          <option key={op} value={op}>
                            {op}
                          </option>
                        ))}
                      </Select>
                      <input
                        className="input input--mono"
                        value={matcher.value}
                        placeholder={t("alerting.editor.labelValue")}
                        aria-label={t("alerting.policies.matcherValueOf", { index: index + 1 })}
                        readOnly={readOnly}
                        onChange={(event) =>
                          update({
                            matchers: draft.matchers.map((m, i) =>
                              i === index ? { ...m, value: event.target.value } : m,
                            ),
                          })
                        }
                      />
                      {readOnly ? (
                        <span />
                      ) : (
                        <button
                          type="button"
                          className="button button--ghost button--small"
                          aria-label={t("alerting.policies.removeMatcher", { index: index + 1 })}
                          onClick={() =>
                            update({ matchers: draft.matchers.filter((_, i) => i !== index) })
                          }
                        >
                          <Icon name="close" />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
                {readOnly || draft.matchers.length >= limits.maxMatchers ? null : (
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    onClick={() =>
                      update({ matchers: [...draft.matchers, { label: "", op: "=", value: "" }] })
                    }
                  >
                    <Icon name="plus" />
                    {t("alerting.policies.addMatcher")}
                  </button>
                )}
                {fieldError("matchers") === undefined ? null : (
                  <p className="field__error" id={`${ids}-matchers-error`} role="alert">
                    <Icon name="alert" />
                    <span>{fieldError("matchers")}</span>
                  </p>
                )}
                <p className="alert-hint">
                  {inheritedConditions.length === 0
                    ? null
                    : `${t("alerting.policies.inheritedMatchers", {
                        conditions: inheritedConditions
                          .map((entry) =>
                            t("alerting.policies.inheritedMatcher", {
                              name: entry.policy,
                              condition: entry.text,
                            }),
                          )
                          .join("; "),
                      })} `}
                  {t("alerting.policies.matcherHint")}
                </p>
              </fieldset>
            )}
          </Step>

          <Step number={2} title={t("alerting.policies.step.contactPoints")}>
            <ContactPicker
              id={`${ids}-contactPointIds`}
              label={t("alerting.policies.contactPointsLabel", { max: limits.maxContactPoints })}
              points={points}
              value={draft.contactPointIds}
              readOnly={readOnly}
              error={fieldError("contactPointIds")}
              onChange={(contactPointIds) => update({ contactPointIds })}
            />
            {isRoot || inherited.contacts === null ? null : (
              <p className="alert-hint">
                {inherited.contacts.value.length === 0
                  ? t("alerting.policies.contactsInheritNone")
                  : t("alerting.policies.contactsInherit", {
                      name: above?.policy.name ?? "",
                      names: inherited.contacts.value
                        .map((id) => points.find((point) => point.id === id)?.name ?? "–")
                        .join(", "),
                    })}
              </p>
            )}
          </Step>

          <Step number={3} title={t("alerting.policies.step.grouping")}>
            <div className="field" id={`${ids}-groupBy`} tabIndex={-1}>
              <span className="field__label">{t("alerting.policies.groupBy")}</span>
              <Segmented
                label={t("alerting.policies.groupBy")}
                value={draft.groupMode}
                disabled={readOnly}
                options={[
                  ...(isRoot
                    ? []
                    : [{ value: "inherit", label: t("alerting.policies.group.inherit") }]),
                  { value: "labels", label: t("alerting.policies.group.labels") },
                  { value: "all", label: t("alerting.policies.group.all") },
                  { value: "each", label: t("alerting.policies.group.each") },
                ]}
                onChange={(value) => update({ groupMode: value as GroupMode })}
              />
              {draft.groupMode === "labels" ? (
                <input
                  className="input input--mono"
                  aria-label={t("alerting.policies.groupByLabels")}
                  value={draft.groupBy.join(", ")}
                  readOnly={readOnly}
                  onChange={(event) =>
                    update({
                      groupBy: event.target.value.split(",").map((part) => part.trimStart()),
                    })
                  }
                />
              ) : null}
              {fieldError("groupBy") === undefined ? null : (
                <p className="field__error" role="alert">
                  <Icon name="alert" />
                  <span>{fieldError("groupBy")}</span>
                </p>
              )}
              <p className="field__hint">
                {draft.groupMode === "inherit" && inherited.groupBy !== null
                  ? t("alerting.policies.groupInherit", {
                      value: groupByText(t, inherited.groupBy.value),
                    })
                  : t("alerting.policies.groupHint")}
              </p>
            </div>
            <div className="alert-grid3">
              <TimeField
                id={`${ids}-groupWaitSecs`}
                label={t("alerting.policies.groupWait")}
                hint={t("alerting.policies.groupWaitHint")}
                choices={GROUP_WAIT_CHOICES}
                value={draft.groupWaitSecs}
                inherited={isRoot ? undefined : inheritedText(inherited.groupWaitSecs?.value)}
                readOnly={readOnly}
                error={fieldError("groupWaitSecs")}
                onChange={(groupWaitSecs) => update({ groupWaitSecs })}
              />
              <TimeField
                id={`${ids}-groupIntervalSecs`}
                label={t("alerting.policies.groupInterval")}
                hint={t("alerting.policies.groupIntervalHint")}
                choices={GROUP_INTERVAL_CHOICES.filter((secs) => secs >= limits.minIntervalSecs)}
                value={draft.groupIntervalSecs}
                inherited={isRoot ? undefined : inheritedText(inherited.groupIntervalSecs?.value)}
                readOnly={readOnly}
                error={fieldError("groupIntervalSecs")}
                onChange={(groupIntervalSecs) => update({ groupIntervalSecs })}
              />
              <TimeField
                id={`${ids}-repeatIntervalSecs`}
                label={t("alerting.policies.repeat")}
                hint={t("alerting.policies.repeatHint")}
                choices={REPEAT_CHOICES}
                repeat
                value={draft.repeatIntervalSecs}
                inherited={
                  isRoot ? undefined : inheritedText(inherited.repeatIntervalSecs?.value, true)
                }
                readOnly={readOnly}
                error={fieldError("repeatIntervalSecs")}
                onChange={(repeatIntervalSecs) => update({ repeatIntervalSecs })}
              />
            </div>
          </Step>

          {isRoot ? null : (
            <Step number={4} title={t("alerting.policies.continue")}>
              <label className="alert-switch-row">
                <input
                  type="checkbox"
                  role="switch"
                  className="settings-switch"
                  checked={draft.continue}
                  aria-checked={draft.continue}
                  disabled={readOnly}
                  onChange={(event) => update({ continue: event.currentTarget.checked })}
                />
                {t("alerting.policies.continueLabel")}
              </label>
              <p className="alert-hint">
                {nextSibling === undefined
                  ? t("alerting.policies.continueHintLast")
                  : t("alerting.policies.continueHint", { name: nextSibling.policy.name })}
              </p>
            </Step>
          )}

          <Step
            number={isRoot ? 4 : 5}
            title={t("alerting.policies.step.escalation")}
            extra={<span className="alert-chip">{t("alerting.policies.notInherited")}</span>}
          >
            <div id={`${ids}-escalations`} tabIndex={-1} className="alert-card alert-escs">
              {draft.escalations.length === 0 ? (
                <p className="alert-muted alert-pad">{t("alerting.policies.noSteps")}</p>
              ) : (
                draft.escalations.map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are in order
                  <div key={index} className="alert-esc">
                    <span className="alert-step__num" aria-hidden="true">
                      {index + 1}
                    </span>
                    <Select
                      value={String(step.waitSecs)}
                      disabled={readOnly}
                      aria-label={t("alerting.policies.stepWaitOf", { level: index + 1 })}
                      onChange={(value) =>
                        update({
                          escalations: draft.escalations.map((s, i) =>
                            i === index ? { ...s, waitSecs: Number(value) } : s,
                          ),
                        })
                      }
                    >
                      {withCurrent(ESCALATION_CHOICES, step.waitSecs).map((secs) => (
                        <option key={secs} value={String(secs)}>
                          {t("alerting.policies.after", { duration: shortDuration(secs) })}
                        </option>
                      ))}
                    </Select>
                    <ContactPicker
                      id={`${ids}-step-${index}`}
                      label={t("alerting.policies.stepContactsOf", { level: index + 1 })}
                      hideLabel
                      points={points}
                      value={step.contactPointIds}
                      readOnly={readOnly}
                      onChange={(contactPointIds) =>
                        update({
                          escalations: draft.escalations.map((s, i) =>
                            i === index ? { ...s, contactPointIds } : s,
                          ),
                        })
                      }
                    />
                    {readOnly ? (
                      <span />
                    ) : (
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        aria-label={t("alerting.policies.removeStep", { level: index + 1 })}
                        onClick={() =>
                          update({ escalations: draft.escalations.filter((_, i) => i !== index) })
                        }
                      >
                        <Icon name="close" />
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            {readOnly || draft.escalations.length >= limits.maxEscalations ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => {
                  const last = draft.escalations.at(-1)?.waitSecs ?? 0;
                  const next = ESCALATION_CHOICES.find((secs) => secs > last) ?? 86_400;
                  update({
                    escalations: [...draft.escalations, { waitSecs: next, contactPointIds: [] }],
                  });
                }}
              >
                <Icon name="plus" />
                {t("alerting.policies.addStep")}
              </button>
            )}
            {fieldError("escalations") === undefined ? null : (
              <p className="field__error" role="alert">
                <Icon name="alert" />
                <span>{fieldError("escalations")}</span>
              </p>
            )}
            <p className="alert-hint">{t("alerting.policies.escalationHint")}</p>
          </Step>
          {node === undefined ? null : (
            <p className="alert-hint">
              {t("alerting.policies.version", {
                version: node.policy.version,
                name: node.policy.updatedByName ?? "",
                at: time(node.policy.updatedAt),
              })}
            </p>
          )}
        </div>
        <div className="alert-editor__side">
          <Summary node={node} above={above} draft={draft} points={points} />
          {node === undefined ? null : <ActiveGroups orgId={orgId} policyId={node.policy.id} />}
        </div>
      </div>
      <ConfirmDialog
        open={deleting && node !== undefined}
        title={t("alerting.policies.deleteTitle", { name: node?.policy.name ?? "" })}
        confirmLabel={t("alerting.policies.menu.delete")}
        busy={remove.isPending}
        error={remove.isError ? alertingErrorText(t, remove.error) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => {
          setDeleting(false);
          remove.reset();
        }}
      >
        {node === undefined ? null : deleteText(t, node)}
      </ConfirmDialog>
    </Page>
  );
}

function inheritedOf(
  node: PolicyNode | undefined,
  above: PolicyNode | null,
): { policy: string; text: string }[] {
  // A new policy inherits everything its parent needs, including the parent's own conditions.
  const entries =
    node !== undefined
      ? inheritedMatchers(node)
      : above === null
        ? []
        : [
            ...inheritedMatchers(above),
            ...above.policy.matchers.map((matcher) => ({ policy: above.policy, matcher })),
          ];
  return entries.map((entry) => ({ policy: entry.policy.name, text: matcherText(entry.matcher) }));
}

/** The field a policy reason (docs/api/alerting.md, "Reasons") is about, to show it there. */
function policyReasonField(error: unknown): PolicyField | undefined {
  switch (errorReason(error)?.reason) {
    case "alerts.policy_name_invalid":
    case "alerts.policy_name_taken":
      return "name";
    case "alerts.policy_matchers_invalid":
    case "alerts.matcher_regex_invalid":
      return "matchers";
    case "alerts.policy_contact_points_invalid":
      return "contactPointIds";
    case "alerts.group_by_invalid":
      return "groupBy";
    case "alerts.escalations_invalid":
      return "escalations";
    default:
      return undefined;
  }
}

function withCurrent(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

/** A time that may be inherited: "Geerbt (30 s)" first, then the choices. */
function TimeField({
  id,
  label,
  hint,
  choices,
  value,
  inherited,
  repeat = false,
  readOnly,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hint: string;
  choices: readonly number[];
  value: number | null;
  /** The inherited value as text; undefined for the root, which sets all times itself. */
  inherited: string | undefined;
  repeat?: boolean;
  readOnly: boolean;
  error: string | undefined;
  onChange: (value: number | null) => void;
}) {
  const { t } = useI18n();
  const options = value === null ? [...choices] : withCurrent(choices, value);
  return (
    <Field
      id={id}
      label={label}
      error={error}
      hint={
        value !== null && inherited !== undefined
          ? `${t("alerting.policies.wouldInherit", { value: inherited })} ${hint}`
          : hint
      }
    >
      <Select
        id={id}
        value={value === null ? "inherit" : String(value)}
        disabled={readOnly}
        onChange={(next) => onChange(next === "inherit" ? null : Number(next))}
      >
        {inherited === undefined ? null : (
          <option value="inherit">
            {t("alerting.policies.inheritedValue", { value: inherited })}
          </option>
        )}
        {options.map((secs) => (
          <option key={secs} value={String(secs)}>
            {timeText(t, secs, repeat)}
          </option>
        ))}
      </Select>
    </Field>
  );
}

/** Up to five contact points as a pick list; read-only shows only the chosen ones. */
function ContactPicker({
  id,
  label,
  hideLabel = false,
  points,
  value,
  readOnly,
  error,
  onChange,
}: {
  id: string;
  label: string;
  hideLabel?: boolean;
  points: readonly ContactPoint[];
  value: readonly string[];
  readOnly: boolean;
  error?: string | undefined;
  onChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  if (readOnly) {
    return (
      <div className="field">
        <span className={hideLabel ? "visually-hidden" : "field__label"}>{label}</span>
        {value.length === 0 ? (
          <span className="alert-muted">{t("alerting.policies.noOwnContacts")}</span>
        ) : (
          <ContactChips ids={value} points={points} />
        )}
      </div>
    );
  }
  return (
    <fieldset
      className="alert-fieldset"
      aria-describedby={error === undefined ? undefined : `${id}-error`}
    >
      <legend className={hideLabel ? "visually-hidden" : "field__label"}>{label}</legend>
      {points.length === 0 ? (
        <p className="alert-muted">{t("alerting.editor.noContactPoints")}</p>
      ) : (
        <ul className="alert-pick-list alert-pick-list--inline" id={id} tabIndex={-1}>
          {points.map((point) => (
            <li key={point.id}>
              <label className="alert-pick">
                <input
                  type="checkbox"
                  checked={value.includes(point.id)}
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? [...value, point.id]
                        : value.filter((other) => other !== point.id),
                    )
                  }
                />
                <ContactChip point={point} />
              </label>
            </li>
          ))}
        </ul>
      )}
      {error === undefined ? null : (
        <p className="field__error" id={`${id}-error`} role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
    </fieldset>
  );
}

/** "So läuft es": the way, conditions, contact points, group and times as they apply now. */
function Summary({
  node,
  above,
  draft,
  points,
}: {
  node: PolicyNode | undefined;
  above: PolicyNode | null;
  draft: PolicyDraft;
  points: readonly ContactPoint[];
}) {
  const { t } = useI18n();
  // The draft's own values, else what it inherits from above.
  const groupBy =
    groupByOf(draft) ?? (above === null ? null : effectiveValue(above, "groupBy").value) ?? [];
  const wait =
    draft.groupWaitSecs ?? (above === null ? 30 : effectiveValue(above, "groupWaitSecs").value);
  const interval =
    draft.groupIntervalSecs ??
    (above === null ? 300 : effectiveValue(above, "groupIntervalSecs").value);
  const repeat =
    draft.repeatIntervalSecs ??
    (above === null ? 14_400 : effectiveValue(above, "repeatIntervalSecs").value);
  const contacts =
    draft.contactPointIds.length > 0
      ? draft.contactPointIds
      : above === null
        ? []
        : effectiveContactPoints(above).value;
  const conditions = [
    ...inheritedOf(node, above).map((entry) => entry.text),
    ...draft.matchers.filter((m) => m.label.trim() !== "").map(matcherText),
  ];
  return (
    <aside aria-label={t("alerting.policies.summary")}>
      <section className="alert-card alert-pad alert-preview">
        <h2 className="alert-step__title">{t("alerting.policies.summary")}</h2>
        <dl className="alert-facts">
          <dt>{t("alerting.policies.facts.way")}</dt>
          <dd>
            {node === undefined ? (
              above === null ? null : (
                <>
                  <WayText node={above} /> › {draft.name.trim() || t("alerting.policies.newTitle")}
                </>
              )
            ) : (
              <WayText node={node} />
            )}
          </dd>
          <dt>{t("alerting.policies.column.matchers")}</dt>
          <dd className="alert-mono-cell">
            {conditions.length === 0 ? t("alerting.policies.rootMatches") : conditions.join(", ")}
          </dd>
          <dt>{t("alerting.policies.column.contactPoints")}</dt>
          <dd>
            {contacts.length === 0 ? (
              <span className="alert-warn-text">{t("alerting.policies.notDelivered")}</span>
            ) : (
              <ContactChips ids={contacts} points={points} />
            )}
          </dd>
          <dt>{t("alerting.policies.facts.group")}</dt>
          <dd>{groupByText(t, groupBy)}</dd>
          <dt>{t("alerting.policies.facts.first")}</dt>
          <dd>
            {wait === 0
              ? t("alerting.policies.facts.firstNow")
              : t("alerting.policies.facts.firstAfter", { duration: shortDuration(wait) })}
          </dd>
          <dt>{t("alerting.policies.facts.changes")}</dt>
          <dd>
            {t("alerting.policies.facts.changesEvery", { duration: shortDuration(interval) })}
          </dd>
          <dt>{t("alerting.policies.facts.reminder")}</dt>
          <dd>
            {repeat === 0
              ? t("alerting.policies.off")
              : t("alerting.policies.facts.reminderEvery", { duration: shortDuration(repeat) })}
          </dd>
          {draft.escalations.length === 0 ? null : (
            <>
              <dt>{t("alerting.policies.facts.escalation")}</dt>
              <dd>{draft.escalations.map((step) => shortDuration(step.waitSecs)).join(", ")}</dd>
            </>
          )}
        </dl>
        {groupBy.length === 1 && groupBy[0] === EACH_INSTANCE ? null : (
          <p className="alert-hint">{t("alerting.policies.groupExplain")}</p>
        )}
      </section>
    </aside>
  );
}

/** The groups of the policy that have instances now, with when they send and escalate next. */
function ActiveGroups({ orgId, policyId }: { orgId: string; policyId: string }) {
  const { t } = useI18n();
  const time = useAlertTime();
  const groups = useQuery({ ...groupsQuery(orgId, policyId), enabled: orgId !== "" });
  const list = groups.data ?? [];
  return (
    <section
      className="alert-card alert-pad alert-preview"
      aria-label={t("alerting.policies.groups")}
    >
      <h2 className="alert-step__title">
        {t("alerting.policies.groups")} <span className="tabs__count">{list.length}</span>
      </h2>
      {groups.isError ? (
        <p className="field__error">{alertingErrorText(t, groups.error)}</p>
      ) : list.length === 0 ? (
        <p className="alert-hint">{t("alerting.policies.noGroups")}</p>
      ) : (
        <ul className="alert-groups">
          {list.map((group) => (
            <li key={group.id} className="alert-group">
              <span className="alert-mono-cell">
                {group.catchAll
                  ? t("alerting.policies.catchAll")
                  : group.dataHidden
                    ? t("alerting.policies.groupHidden")
                    : Object.entries(group.labels)
                        .map(([key, value]) => `${key}=${value}`)
                        .join(", ")}
              </span>
              <span className="alert-muted">
                {[
                  group.state === "waiting"
                    ? t("alerting.policies.groupWaiting")
                    : group.firingSince === null
                      ? t("alerting.policies.groupInstances", { count: group.instances })
                      : t("alerting.policies.groupFiring", { at: time(group.firingSince) }),
                  group.escalationLevel === 0
                    ? null
                    : t("alerting.policies.groupLevel", { level: group.escalationLevel }),
                  group.escalationPaused ? t("alerting.policies.groupPaused") : null,
                  group.nextRepeatAt === null
                    ? null
                    : t("alerting.policies.groupNextRepeat", { at: time(group.nextRepeatAt) }),
                ]
                  .filter((part) => part !== null)
                  .join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Step({
  number,
  title,
  extra,
  children,
}: {
  number: number;
  title: string;
  extra?: ReactNode;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="alert-step" aria-labelledby={id}>
      <header className="alert-step__head">
        <span className="alert-step__num" aria-hidden="true">
          {number}
        </span>
        <h2 id={id} className="alert-step__title">
          {title}
        </h2>
        {extra}
      </header>
      <div className="alert-step__body">{children}</div>
    </section>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string | undefined;
  children: ReactNode;
}) {
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {children}
      {error === undefined ? null : (
        <p className="field__error" id={`${id}-error`} role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}
