import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { cloneElement, isValidElement, type ReactNode, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { dashboardQuery } from "../dashboards/api";
import { datasourcesQuery } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import {
  ALERTING_KEY,
  type AlertingSource,
  alertingSourcesQuery,
  COMPARISONS,
  type ConditionOp,
  type ContactPoint,
  contactPointsQuery,
  createRule,
  FIELD_FUNCTIONS,
  FRAME_FUNCTIONS,
  GRAPH_COUNTS,
  type PreviewInstance,
  parseRule,
  RANGES,
  type Rule,
  ruleQuery,
  setRulePaused,
  updateRule,
} from "./api";
import { routingAvailable } from "./policies";
import { RulePreview } from "./RulePreview";
import { DirectNote, PolicyRoutes } from "./RuleRouting";
import { alertingErrorText, reasonField } from "./reasons";
import type { NewRuleSearch } from "./routes";
import {
  type DraftErrors,
  type DraftField,
  draftFromPanel,
  draftFromRule,
  durationText,
  emptyDraft,
  forChoices,
  inputOf,
  intervalChoices,
  MAX_LABELS,
  type PanelSource,
  panelChanged,
  panelQuery,
  RANGE_CHOICES,
  REMINDER_CHOICES,
  type RuleDraft,
  type Shape,
  shapeForKind,
  validateDraft,
  withInterval,
} from "./ruleModel";
import { Segmented, useAlerting, useAlertTime } from "./shared";

/** "Neue Regel": empty, from a panel, or a copy of another rule. */
export function NewRulePage() {
  const search = useSearch({ from: "/_app/alerting/rules/new" }) as NewRuleSearch;
  const { orgId } = useAlerting();
  const panel = usePanelSource(orgId, search.dashboard, search.panel);
  const from = useQuery({
    ...ruleQuery(orgId, search.from ?? ""),
    enabled: search.from !== undefined,
  });
  const { t } = useI18n();
  if (
    (search.dashboard !== undefined && panel.pending) ||
    (search.from !== undefined && from.isPending)
  ) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  let initial = emptyDraft();
  if (from.data !== undefined) {
    initial = {
      ...draftFromRule(from.data),
      name: t("alerting.editor.copyName", { name: from.data.name }),
    };
  } else if (panel.source !== undefined) {
    initial = draftFromPanel(panel.source);
  }
  return (
    <RuleEditor
      key={`${search.dashboard}:${search.panel}:${search.from}`}
      initial={initial}
      panel={panel.source}
    />
  );
}

/** An existing rule: its fields, version and the panel it was made from. */
export function EditRulePage() {
  const { ruleId } = useParams({ from: "/_app/alerting/rules/$ruleId" });
  const { orgId } = useAlerting();
  const { t } = useI18n();
  const rule = useQuery({ ...ruleQuery(orgId, ruleId), enabled: orgId !== "" });
  const panel = usePanelSource(
    orgId,
    rule.data?.dashboardId ?? undefined,
    rule.data?.panelId ?? undefined,
  );
  if (rule.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (rule.isError) {
    return (
      <Page title={t("alerting.editor.title")}>
        <EmptyState icon="alert" title={t("alerting.editor.notFound")}>
          {alertingErrorText(t, rule.error)}
        </EmptyState>
      </Page>
    );
  }
  return (
    <RuleEditor
      key={`${rule.data.id}:${rule.data.version}`}
      stored={rule.data}
      initial={draftFromRule(rule.data)}
      panel={panel.source}
    />
  );
}

/** The panel a rule was made from (or is made from now), read with the person's rights. */
function usePanelSource(
  orgId: string,
  dashboardId: string | undefined,
  panelId: string | undefined,
): { source: PanelSource | undefined; pending: boolean } {
  const dashboard = useQuery({
    ...dashboardQuery(orgId, dashboardId ?? ""),
    enabled: orgId !== "" && dashboardId !== undefined,
  });
  if (dashboardId === undefined || panelId === undefined) {
    return { source: undefined, pending: false };
  }
  const model = dashboard.data?.model;
  const panel = model?.panels.find((p) => p.id === panelId);
  if (model === undefined || panel === undefined) {
    return { source: undefined, pending: dashboard.isPending };
  }
  const target = panel.targets.find((item) => item.hide !== true) ?? panel.targets[0];
  return {
    pending: false,
    source: {
      dashboardId,
      panelId,
      title: panel.title,
      dashboardTitle: model.title,
      timeFrom: panel.timeFrom === undefined ? model.timeRange.from : `now-${panel.timeFrom}`,
      target:
        target === undefined
          ? undefined
          : { datasourceId: target.datasourceId, query: target.query },
      variables: model.variables,
    },
  };
}

const COMPARISON_KEYS: Record<ConditionOp, MessageKey> = {
  gt: "alerting.condition.gt",
  gte: "alerting.condition.gte",
  lt: "alerting.condition.lt",
  lte: "alerting.condition.lte",
  eq: "alerting.condition.eq",
  ne: "alerting.condition.ne",
  outside: "alerting.condition.outside",
  inside: "alerting.condition.inside",
};

/**
 * The rule editor (board Alerting.dc.html, frames 4 to 7): five steps under each other (query,
 * reduce, condition, evaluation, labels and notification), the preview of the evaluation and the
 * message on the right, and one explicit save. A save on an older version shows the stored one.
 */
function RuleEditor({
  initial,
  stored,
  panel,
}: {
  initial: RuleDraft;
  stored?: Rule;
  panel: PanelSource | undefined;
}) {
  const { t } = useI18n();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, status, canWrite, canContacts } = useAlerting();
  const routingOn = routingAvailable(status);
  const [previewed, setPreviewed] = useState<readonly PreviewInstance[] | undefined>(undefined);
  useDocumentTitle(stored === undefined ? "alerting.editor.newTitle" : "alerting.editor.title");
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<DraftErrors>({});
  const [conflict, setConflict] = useState<Rule | null>(null);
  const [paused, setPaused] = useState(stored?.paused ?? false);
  // Pausing and resuming raise the stored version; a later Save sends the one they answered, so
  // it does not conflict with the person's own change. The draft stays as it is.
  const [version, setVersion] = useState(stored?.version ?? 0);
  const sources = useQuery({ ...alertingSourcesQuery(orgId), enabled: orgId !== "" });
  const allSources = useQuery({ ...datasourcesQuery(orgId), enabled: orgId !== "" });
  const points = useQuery({ ...contactPointsQuery(orgId), enabled: orgId !== "" });
  const time = useAlertTime();
  const bounds = {
    minIntervalSecs: status?.limits.minIntervalSecs ?? 30,
    maxContactPointsPerRule: status?.limits.maxContactPointsPerRule ?? 5,
  };
  const readOnly = !canWrite || stored?.queryHidden === true;
  const source: AlertingSource | undefined =
    sources.data?.find((item) => item.datasourceId === draft.datasourceId) ??
    (() => {
      const any = allSources.data?.find((item) => item.id === draft.datasourceId);
      return any === undefined
        ? undefined
        : { datasourceId: any.id, name: any.name, kind: any.kind };
    })();
  const sourceOptedIn =
    sources.data?.some((item) => item.datasourceId === draft.datasourceId) ?? true;

  const save = useMutation({
    mutationFn: async (overwrite: Rule | null) => {
      const input = inputOf(draft, routingOn);
      if (stored === undefined) return createRule(orgId, input);
      return updateRule(orgId, stored.id, input, overwrite?.version ?? version);
    },
    onSuccess: async (saved) => {
      setConflict(null);
      showToast({ message: t("alerting.editor.saved", { name: saved.name }) });
      queryClient.setQueryData([ALERTING_KEY, orgId, "rule", saved.id], saved);
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId] });
      if (stored === undefined) {
        void navigate({ to: "/alerting/rules/$ruleId", params: { ruleId: saved.id } });
      }
    },
    onError: (error) => {
      if (isApiError(error, "version_conflict") && error.current !== undefined) {
        try {
          setConflict(parseRule(error.current));
        } catch {
          setConflict(null);
        }
      }
    },
  });
  const pause = useMutation({
    mutationFn: (next: boolean) => setRulePaused(orgId, stored?.id ?? "", next),
    onSuccess: async (saved) => {
      setPaused(saved.paused);
      setVersion(saved.version);
      showToast({
        message: t(saved.paused ? "alerting.rules.paused" : "alerting.rules.resumed", {
          name: saved.name,
        }),
      });
      await queryClient.invalidateQueries({ queryKey: [ALERTING_KEY, orgId, "rules"] });
    },
    onError: (error) => showToast({ message: alertingErrorText(t, error), error: true }),
  });

  function update(patch: Partial<RuleDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function submit() {
    const errors = validateDraft(draft, bounds);
    setShown(errors);
    if (Object.keys(errors).length > 0) {
      const first = Object.keys(errors)[0];
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    save.mutate(null);
  }

  // A server reason that belongs to a field shows there; the others above the form.
  const serverField = save.isError && conflict === null ? reasonField(save.error) : undefined;
  const fieldError = (field: DraftField): string | undefined => {
    const own = shown[field];
    if (own !== undefined) return t(own.key, own.params ?? {});
    if (serverField === field) return alertingErrorText(t, save.error);
    return undefined;
  };
  const formError =
    save.isError && conflict === null && serverField === undefined
      ? alertingErrorText(t, save.error)
      : null;

  const title = stored === undefined ? t("alerting.editor.newTitle") : stored.name;
  const shapeLabel = draft.shape;
  const panelTitle = panel?.dashboardTitle;

  return (
    <Page title={title}>
      <Breadcrumbs
        crumbs={[
          { label: t("alerting.title"), link: { to: "/alerting" } },
          { label: t("alerting.tab.rules"), link: { to: "/alerting" } },
          { label: title },
        ]}
      />
      <PageActions>
        <Link to="/alerting" className="button button--secondary">
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
          {conflict === null ? null : (
            <div className="notice notice--danger" role="alert">
              <Icon name="alert" />
              <div>
                <p>
                  {t("alerting.editor.conflict", {
                    name: conflict.updatedByName ?? "",
                    version: conflict.version,
                  })}
                </p>
                <div className="alert-row-actions">
                  <button
                    type="button"
                    className="button button--secondary button--small"
                    onClick={() => {
                      setDraft(draftFromRule(conflict));
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
          {stored?.queryHidden === true ? (
            <p className="alert-note">{t("alerting.editor.queryHidden")}</p>
          ) : null}
          <section
            className="alert-card alert-pad alert-head-fields"
            aria-label={t("alerting.editor.general")}
          >
            <Field id={`${ids}-name`} label={t("alerting.editor.name")} error={fieldError("name")}>
              <input
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                maxLength={200}
                readOnly={readOnly}
                aria-invalid={fieldError("name") === undefined ? undefined : true}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field id={`${ids}-description`} label={t("alerting.editor.description")}>
              <input
                id={`${ids}-description`}
                className="input"
                value={draft.description}
                readOnly={readOnly}
                onChange={(event) => update({ description: event.target.value })}
              />
            </Field>
            {stored === undefined ? null : (
              <div className="alert-head-fields__meta">
                <label className="alert-switch-row">
                  <input
                    type="checkbox"
                    role="switch"
                    className="settings-switch"
                    checked={!paused}
                    aria-checked={!paused}
                    disabled={readOnly}
                    onChange={(event) =>
                      !pause.isPending && pause.mutate(!event.currentTarget.checked)
                    }
                  />
                  {t("alerting.editor.active")}
                </label>
                <span className="alert-muted">
                  {t("alerting.editor.version", {
                    version,
                    name: stored.updatedByName ?? "",
                    at: time(stored.updatedAt),
                  })}
                </span>
              </div>
            )}
          </section>

          <Step
            number={1}
            title={t("alerting.editor.step.query")}
            extra={<span className="alert-chip alert-chip--mono">{shapeLabel}</span>}
          >
            {panel === undefined ? null : (
              <p className="alert-muted">
                {t("alerting.editor.fromPanel", {
                  panel: panel.title,
                  dashboard: panelTitle ?? "",
                })}
              </p>
            )}
            {panel !== undefined &&
            stored !== undefined &&
            !readOnly &&
            panelChanged(draft, panel) ? (
              <div className="alert-note alert-note--row">
                <span>{t("alerting.editor.panelChanged")}</span>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => update(panelQuery(panel))}
                >
                  {t("alerting.editor.takeQuery")}
                </button>
              </div>
            ) : null}
            <div className="alert-grid2">
              <Field
                id={`${ids}-datasourceId`}
                label={t("alerting.editor.source")}
                error={fieldError("datasourceId")}
              >
                <Select
                  id={`${ids}-datasourceId`}
                  value={draft.datasourceId}
                  disabled={readOnly}
                  aria-invalid={fieldError("datasourceId") === undefined ? undefined : true}
                  onChange={(id) => {
                    const kind = sources.data?.find((item) => item.datasourceId === id)?.kind ?? "";
                    update({ datasourceId: id, query: undefined, shape: shapeForKind(kind) });
                  }}
                >
                  <option value="" hidden>
                    {t("alerting.editor.sourcePick")}
                  </option>
                  {(sources.data ?? []).map((item) => (
                    <option key={item.datasourceId} value={item.datasourceId}>
                      {item.name}
                    </option>
                  ))}
                  {source !== undefined && !sourceOptedIn ? (
                    <option value={source.datasourceId}>{source.name}</option>
                  ) : null}
                </Select>
              </Field>
              <Field id={`${ids}-range`} label={t("alerting.editor.range")}>
                <Select
                  id={`${ids}-range`}
                  value={String(draft.rangeSecs)}
                  disabled={readOnly}
                  onChange={(value) => update({ rangeSecs: Number(value) })}
                >
                  {withCurrent(RANGE_CHOICES, draft.rangeSecs).map((secs) => (
                    <option key={secs} value={String(secs)}>
                      {t("alerting.editor.rangeLast", { duration: durationText(t, secs) })}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {sources.data !== undefined && sources.data.length === 0 ? (
              <p className="alert-note">{t("alerting.editor.noSources")}</p>
            ) : null}
            {Object.keys(draft.variables).length === 0 ? null : (
              <p className="alert-muted">
                {t("alerting.editor.variables")}{" "}
                {Object.entries(draft.variables).map(([name, value]) => (
                  <span key={name} className="alert-chip alert-chip--mono">
                    ${name} = {Array.isArray(value) ? value.join(", ") : String(value)}
                  </span>
                ))}
              </p>
            )}
            {source === undefined ? null : (
              <div className={fieldError("query") === undefined ? undefined : "alert-invalid"}>
                {readOnly ? (
                  <pre className="alert-code">{JSON.stringify(draft.query, null, 2)}</pre>
                ) : (
                  <QueryEditor
                    orgId={orgId}
                    datasource={{ id: source.datasourceId, kind: source.kind }}
                    query={draft.query}
                    onChange={(query) => update({ query })}
                    label={t("alerting.editor.query")}
                  />
                )}
                {fieldError("query") === undefined ? null : (
                  <p className="field__error" id={`${ids}-query`} role="alert">
                    <Icon name="alert" />
                    <span>{fieldError("query")}</span>
                  </p>
                )}
              </div>
            )}
            {draft.steps.length === 0 ? null : (
              <div className="alert-steps">
                <span className="alert-muted">
                  {t("alerting.editor.steps", { count: draft.steps.length })}
                </span>
                {draft.steps.map((step, index) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: steps are in order and only removed
                  <span key={index} className="alert-chip alert-chip--mono">
                    {stepName(step)}
                    {readOnly ? null : (
                      <button
                        type="button"
                        className="alert-chip__remove"
                        aria-label={t("alerting.editor.removeStep", { name: stepName(step) })}
                        onClick={() => update({ steps: draft.steps.filter((_, i) => i !== index) })}
                      >
                        <Icon name="close" />
                      </button>
                    )}
                  </span>
                ))}
              </div>
            )}
            {source === undefined ? null : (
              <p className="alert-hint">
                {sourceOptedIn ? t("alerting.editor.optedIn") : t("alerting.editor.notOptedIn")}
              </p>
            )}
          </Step>

          <Step
            number={2}
            title={t("alerting.editor.step.reduce")}
            extra={
              <span className="alert-muted">{t(`alerting.editor.reduceLead.${draft.shape}`)}</span>
            }
          >
            <Segmented
              label={t("alerting.editor.shape")}
              value={draft.shape}
              disabled={readOnly}
              options={(["frame", "documents", "graph"] as const).map((shape) => ({
                value: shape,
                label: shape,
                mono: true,
              }))}
              onChange={(shape) => update({ shape: shape as Shape })}
            />
            {draft.shape === "frame" ? (
              <>
                <Segmented
                  label={t("alerting.editor.function")}
                  value={draft.frameFunction}
                  disabled={readOnly}
                  options={FRAME_FUNCTIONS.map((fn) => ({ value: fn, label: fn, mono: true }))}
                  onChange={(fn) => update({ frameFunction: fn as RuleDraft["frameFunction"] })}
                />
                <p className="alert-hint">
                  {t(`alerting.editor.frameHint.${draft.frameFunction}`)}
                </p>
              </>
            ) : null}
            {draft.shape === "documents" ? (
              <>
                <Segmented
                  label={t("alerting.editor.documentsMode")}
                  value={draft.documentsMode}
                  disabled={readOnly}
                  options={[
                    { value: "count", label: t("alerting.editor.documentsCount") },
                    { value: "field", label: t("alerting.editor.documentsField") },
                  ]}
                  onChange={(mode) => update({ documentsMode: mode as "count" | "field" })}
                />
                {draft.documentsMode === "field" ? (
                  <div className="alert-grid2">
                    <Field
                      id={`${ids}-documentsPath`}
                      label={t("alerting.editor.path")}
                      error={fieldError("documentsPath")}
                    >
                      <input
                        id={`${ids}-documentsPath`}
                        className="input input--mono"
                        value={draft.documentsPath}
                        placeholder="$.queue.depth"
                        spellCheck={false}
                        readOnly={readOnly}
                        aria-invalid={fieldError("documentsPath") === undefined ? undefined : true}
                        onChange={(event) => update({ documentsPath: event.target.value })}
                      />
                    </Field>
                    <Field id={`${ids}-fieldFunction`} label={t("alerting.editor.function")}>
                      <Select
                        id={`${ids}-fieldFunction`}
                        value={draft.documentsFunction}
                        disabled={readOnly}
                        onChange={(fn) =>
                          update({ documentsFunction: fn as RuleDraft["documentsFunction"] })
                        }
                      >
                        {FIELD_FUNCTIONS.map((fn) => (
                          <option key={fn} value={fn}>
                            {fn}
                          </option>
                        ))}
                      </Select>
                    </Field>
                  </div>
                ) : null}
                <p className="alert-hint">
                  {t(
                    draft.documentsMode === "count"
                      ? "alerting.editor.countHint"
                      : "alerting.editor.fieldHint",
                  )}
                </p>
              </>
            ) : null}
            {draft.shape === "graph" ? (
              <>
                <Segmented
                  label={t("alerting.editor.graphCount")}
                  value={draft.graphCount}
                  disabled={readOnly}
                  options={GRAPH_COUNTS.map((count) => ({
                    value: count,
                    label: t(`alerting.reduce.graph.${count}`),
                  }))}
                  onChange={(count) => update({ graphCount: count as RuleDraft["graphCount"] })}
                />
                {draft.graphCount === "paths" ? null : (
                  <Field
                    id={`${ids}-graphLabel`}
                    label={t("alerting.editor.graphLabel")}
                    error={fieldError("graphLabel")}
                  >
                    <input
                      id={`${ids}-graphLabel`}
                      className="input input--mono"
                      value={draft.graphLabel}
                      placeholder={t("alerting.editor.graphLabelAll")}
                      readOnly={readOnly}
                      onChange={(event) => update({ graphLabel: event.target.value })}
                    />
                  </Field>
                )}
                <p className="alert-hint">{t("alerting.editor.graphHint")}</p>
              </>
            ) : null}
          </Step>

          <Step number={3} title={t("alerting.editor.step.condition")}>
            <p className="alert-muted">{t("alerting.editor.firesWhen")}</p>
            <div className="alert-grid3">
              <Field id={`${ids}-op`} label={t("alerting.editor.comparison")}>
                <Select
                  id={`${ids}-op`}
                  value={draft.op}
                  disabled={readOnly}
                  onChange={(op) => update({ op: op as ConditionOp })}
                >
                  {[...COMPARISONS, ...RANGES].map((op) => (
                    <option key={op} value={op}>
                      {t(COMPARISON_KEYS[op])}
                    </option>
                  ))}
                </Select>
              </Field>
              {draft.op === "outside" || draft.op === "inside" ? (
                <>
                  <NumberField
                    id={`${ids}-low`}
                    label={t("alerting.editor.low")}
                    value={draft.low}
                    error={fieldError("low")}
                    readOnly={readOnly}
                    onChange={(low) => update({ low })}
                  />
                  <NumberField
                    id={`${ids}-high`}
                    label={t("alerting.editor.high")}
                    value={draft.high}
                    error={fieldError("high")}
                    readOnly={readOnly}
                    onChange={(high) => update({ high })}
                  />
                </>
              ) : (
                <NumberField
                  id={`${ids}-value`}
                  label={t("alerting.editor.threshold")}
                  value={draft.value}
                  error={fieldError("value")}
                  readOnly={readOnly}
                  onChange={(value) => update({ value })}
                />
              )}
            </div>
            <p className="alert-hint">{t("alerting.editor.conditionHint")}</p>
          </Step>

          <Step number={4} title={t("alerting.editor.step.evaluation")}>
            <div className="alert-grid2">
              <Field
                id={`${ids}-intervalSecs`}
                label={t("alerting.editor.interval")}
                hint={t("alerting.editor.intervalHint", {
                  min: durationText(t, bounds.minIntervalSecs),
                })}
                error={fieldError("intervalSecs")}
              >
                <Select
                  id={`${ids}-intervalSecs`}
                  value={String(draft.intervalSecs)}
                  disabled={readOnly}
                  onChange={(value) => setDraft((current) => withInterval(current, Number(value)))}
                >
                  {intervalChoices(bounds.minIntervalSecs, draft.intervalSecs).map((secs) => (
                    <option key={secs} value={String(secs)}>
                      {durationText(t, secs)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field
                id={`${ids}-forSecs`}
                label={t("alerting.editor.for")}
                hint={t("alerting.editor.forHint")}
                error={fieldError("forSecs")}
              >
                <Select
                  id={`${ids}-forSecs`}
                  value={String(draft.forSecs)}
                  disabled={readOnly}
                  onChange={(value) => update({ forSecs: Number(value) })}
                >
                  {forChoices(draft.intervalSecs, draft.forSecs).map((secs) => (
                    <option key={secs} value={String(secs)}>
                      {secs === 0 ? t("alerting.editor.forNow") : durationText(t, secs)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field id={`${ids}-noData`} label={t("alerting.editor.noData")}>
                <Select
                  id={`${ids}-noData`}
                  value={draft.noDataState}
                  disabled={readOnly}
                  onChange={(value) => update({ noDataState: value as RuleDraft["noDataState"] })}
                >
                  <option value="no_data">{t("alerting.editor.noDataState")}</option>
                  <option value="ok">{t("alerting.editor.noDataOk")}</option>
                  <option value="firing">{t("alerting.editor.noDataFiring")}</option>
                </Select>
              </Field>
              <Field id={`${ids}-error`} label={t("alerting.editor.onError")}>
                <Select
                  id={`${ids}-error`}
                  value={draft.errorState}
                  disabled={readOnly}
                  onChange={(value) => update({ errorState: value as RuleDraft["errorState"] })}
                >
                  <option value="error">{t("alerting.editor.errorState")}</option>
                  <option value="keep">{t("alerting.editor.errorKeep")}</option>
                </Select>
              </Field>
            </div>
          </Step>

          <Step number={5} title={t("alerting.editor.step.notify")}>
            <fieldset
              className="alert-fieldset"
              aria-describedby={
                fieldError("labels") === undefined ? undefined : `${ids}-labels-error`
              }
            >
              <legend className="field__label">{t("alerting.editor.labels")}</legend>
              {draft.labels.map((row, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are edited in place
                <div key={index} className="alert-label-row">
                  <input
                    className="input input--mono"
                    value={row.key}
                    placeholder={t("alerting.editor.labelKey")}
                    aria-label={t("alerting.editor.labelKeyNamed", { index: index + 1 })}
                    readOnly={readOnly}
                    onChange={(event) =>
                      update({
                        labels: draft.labels.map((r, i) =>
                          i === index ? { ...r, key: event.target.value } : r,
                        ),
                      })
                    }
                  />
                  <input
                    className="input input--mono"
                    value={row.value}
                    placeholder={t("alerting.editor.labelValue")}
                    aria-label={t("alerting.editor.labelValueNamed", { index: index + 1 })}
                    readOnly={readOnly}
                    onChange={(event) =>
                      update({
                        labels: draft.labels.map((r, i) =>
                          i === index ? { ...r, value: event.target.value } : r,
                        ),
                      })
                    }
                  />
                  {readOnly ? null : (
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      aria-label={t("alerting.editor.removeLabel", {
                        name: row.key || String(index + 1),
                      })}
                      title={t("alerting.editor.removeLabelShort")}
                      onClick={() => update({ labels: draft.labels.filter((_, i) => i !== index) })}
                    >
                      <Icon name="close" />
                    </button>
                  )}
                </div>
              ))}
              {readOnly || draft.labels.length >= MAX_LABELS ? null : (
                <button
                  type="button"
                  className="button button--ghost button--small"
                  onClick={() => update({ labels: [...draft.labels, { key: "", value: "" }] })}
                >
                  <Icon name="plus" />
                  {t("alerting.editor.addLabel")}
                </button>
              )}
              {fieldError("labels") === undefined ? null : (
                <p className="field__error" id={`${ids}-labels-error`} role="alert">
                  <Icon name="alert" />
                  <span>{fieldError("labels")}</span>
                </p>
              )}
            </fieldset>
            {routingOn ? (
              <div className="field">
                <span className="field__label" id={`${ids}-routing-label`}>
                  {t("alerting.routing.label")}
                </span>
                <Segmented
                  label={t("alerting.routing.label")}
                  value={draft.routing}
                  disabled={readOnly}
                  options={[
                    { value: "policies", label: t("alerting.routing.policies") },
                    { value: "direct", label: t("alerting.routing.directLabel") },
                  ]}
                  onChange={(value) =>
                    update({ routing: value === "direct" ? "direct" : "policies" })
                  }
                />
                <p className="field__hint">{t("alerting.routing.hint")}</p>
              </div>
            ) : null}
            {routingOn && draft.routing === "policies" ? (
              <PolicyRoutes
                orgId={orgId}
                draft={draft}
                instances={previewed}
                points={points.data ?? []}
                canContacts={canContacts}
              />
            ) : (
              <>
                <fieldset
                  className="alert-fieldset"
                  aria-describedby={
                    fieldError("contactPointIds") === undefined
                      ? undefined
                      : `${ids}-contactPointIds-error`
                  }
                >
                  <legend className="field__label">
                    {t("alerting.editor.contactPoints", { max: bounds.maxContactPointsPerRule })}
                  </legend>
                  {(points.data ?? []).length === 0 ? (
                    <p className="alert-muted">{t("alerting.editor.noContactPoints")}</p>
                  ) : (
                    <ul className="alert-pick-list" id={`${ids}-contactPointIds`} tabIndex={-1}>
                      {(points.data ?? []).map((point) => (
                        <li key={point.id}>
                          <label className="alert-pick">
                            <input
                              type="checkbox"
                              checked={draft.contactPointIds.includes(point.id)}
                              disabled={readOnly}
                              onChange={(event) =>
                                update({
                                  contactPointIds: event.target.checked
                                    ? [...draft.contactPointIds, point.id]
                                    : draft.contactPointIds.filter((id) => id !== point.id),
                                })
                              }
                            />
                            <span className="alert-pick__name">{point.name}</span>
                            <span className="alert-muted">{contactSummary(t, point)}</span>
                          </label>
                        </li>
                      ))}
                    </ul>
                  )}
                  {fieldError("contactPointIds") === undefined ? null : (
                    <p className="field__error" id={`${ids}-contactPointIds-error`} role="alert">
                      <Icon name="alert" />
                      <span>{fieldError("contactPointIds")}</span>
                    </p>
                  )}
                  <p className="alert-hint">{t("alerting.editor.contactPointsHint")}</p>
                </fieldset>
                {routingOn ? (
                  <DirectNote
                    orgId={orgId}
                    draft={draft}
                    points={points.data ?? []}
                    readOnly={readOnly}
                    onSwitch={() => update({ routing: "policies" })}
                  />
                ) : null}
              </>
            )}
            <div className="alert-grid2">
              {routingOn && draft.routing === "policies" ? null : (
                <Field id={`${ids}-reminder`} label={t("alerting.editor.reminder")}>
                  <Select
                    id={`${ids}-reminder`}
                    value={String(draft.reminderSecs)}
                    disabled={readOnly}
                    onChange={(value) => update({ reminderSecs: Number(value) })}
                  >
                    {withCurrent(REMINDER_CHOICES, draft.reminderSecs).map((secs) => (
                      <option key={secs} value={String(secs)}>
                        {secs === 0
                          ? t("alerting.editor.reminderOff")
                          : t("alerting.editor.reminderEvery", { duration: durationText(t, secs) })}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field
                id={`${ids}-runbookUrl`}
                label={t("alerting.editor.runbook")}
                error={fieldError("runbookUrl")}
              >
                <input
                  id={`${ids}-runbookUrl`}
                  className="input"
                  type="url"
                  value={draft.runbookUrl}
                  placeholder="https://"
                  readOnly={readOnly}
                  aria-invalid={fieldError("runbookUrl") === undefined ? undefined : true}
                  onChange={(event) => update({ runbookUrl: event.target.value })}
                />
              </Field>
            </div>
          </Step>
        </div>
        <RulePreview
          orgId={orgId}
          draft={draft}
          canRun={source !== undefined && !readOnly}
          contactPoints={points.data ?? []}
          routing={routingOn ? draft.routing : "direct"}
          onPreview={(preview) => setPreviewed(preview.instances)}
        />
      </div>
    </Page>
  );
}

function withCurrent(choices: readonly number[], current: number): number[] {
  return choices.includes(current) ? [...choices] : [...choices, current].sort((a, b) => a - b);
}

function stepName(step: unknown): string {
  if (typeof step === "object" && step !== null) {
    const record = step as Record<string, unknown>;
    for (const key of ["type", "op", "kind", "name"]) {
      if (typeof record[key] === "string") return record[key] as string;
    }
  }
  return "step";
}

/** A Slack or Teams URL as it is shown after saving: the host and its last four characters. */
export function chatUrlText(point: Pick<ContactPoint, "host" | "urlEnd"> | null): string {
  if (point === null) return "";
  return `${point.host ?? ""}/…/…${point.urlEnd ?? ""}`;
}

export function contactSummary(t: ReturnType<typeof useI18n>["t"], point: ContactPoint): string {
  if (point.kind === "slack" || point.kind === "teams") {
    return t("alerting.contact.chatSummary", {
      host: point.host ?? "",
      language: t(point.language === "de" ? "alerting.contact.german" : "alerting.contact.english"),
    });
  }
  if (point.kind === "mail") {
    const count = point.recipients?.length ?? 0;
    return t("alerting.contact.mailSummary", {
      count,
      language: t(point.language === "de" ? "alerting.contact.german" : "alerting.contact.english"),
    });
  }
  return t("alerting.contact.webhookSummary", { host: point.host ?? "" });
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
  // The error and the hint describe the control, so a screen reader reads them with it.
  const describedBy =
    [error === undefined ? null : `${id}-error`, hint === undefined ? null : `${id}-hint`]
      .filter((part) => part !== null)
      .join(" ") || undefined;
  const control = isValidElement<Record<string, unknown>>(children)
    ? cloneElement(children, { "aria-describedby": describedBy })
    : children;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {control}
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

function NumberField({
  id,
  label,
  value,
  error,
  readOnly,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  error: string | undefined;
  readOnly: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <Field id={id} label={label} error={error}>
      <input
        id={id}
        className="input"
        inputMode="decimal"
        value={value}
        readOnly={readOnly}
        aria-invalid={error === undefined ? undefined : true}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
