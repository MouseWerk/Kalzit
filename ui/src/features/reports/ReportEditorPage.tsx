import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useParams, useSearch } from "@tanstack/react-router";
import { cloneElement, isValidElement, type ReactNode, useId, useState } from "react";
import { isApiError } from "../../api/client";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { Select } from "../../components/Select";
import { type Language, useI18n } from "../../i18n/i18n";
import { formatBytes } from "../../lib/bytes";
import { browserZone, timeZones } from "../../lib/timeSettings";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { dashboardQuery, fetchDashboards } from "../dashboards/api";
import { optionChoices, readingOrder, type VariableModel } from "../dashboards/model";
import { rangeLabel } from "../dashboards/rangeLabel";
import { PRESETS } from "../dashboards/timeRange";
import {
  createReport,
  REPORTS_KEY,
  type Report,
  type ReportInput,
  reportQuery,
  sendNow,
  setReportPaused,
  updateReport,
} from "./api";
import {
  type DraftErrors,
  type DraftField,
  draftFromReport,
  emptyDraft,
  type FormatChoice,
  formatsText,
  inputOf,
  nextRuns,
  type ReportDraft,
  reachable,
  recipientsText,
  SCHEDULE_KINDS,
  scheduleOf,
  scheduleText,
  validateDraft,
  WEEKDAYS,
  weekdayName,
} from "./model";
import { PreviewDialog } from "./PreviewDialog";
import { RecipientsField } from "./RecipientsField";
import { SendDialog } from "./ReportsPage";
import { codeText, errorField, errorRecipient, reportErrorText } from "./reasons";
import type { NewReportSearch } from "./routes";
import { ReportsFrame, ReportTabs, Segmented, useReports, useReportTime } from "./shared";
import "../alerting/alerting.css";
import "./reports.css";

/** "Neuer Bericht": empty, from a dashboard as it is shown now, or a copy of another report. */
export function NewReportPage() {
  const search = useSearch({ from: "/_app/reports/new" }) as NewReportSearch;
  const { t, language, timeZone } = useI18n();
  const { orgId } = useReports();
  const copy = useQuery({
    ...reportQuery(orgId, search.copy ?? ""),
    enabled: search.copy !== undefined && orgId !== "",
  });
  if (search.copy !== undefined && copy.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  let initial = emptyDraft(timeZone ?? browserZone(), language);
  if (copy.data !== undefined) {
    initial = {
      ...draftFromReport(copy.data),
      name: t("reports.copyName", { name: copy.data.name }),
      paused: false,
    };
  } else if (search.dashboard !== undefined) {
    initial = {
      ...initial,
      dashboardId: search.dashboard,
      range:
        search.from !== undefined && search.to !== undefined ? `${search.from}|${search.to}` : "",
      variables: search.vars ?? {},
    };
  }
  return <ReportEditor key={`${search.dashboard}:${search.copy}`} initial={initial} />;
}

/** An existing report: its settings, and its runs on the page next to it. */
export function EditReportPage() {
  const { reportId } = useParams({ from: "/_app/reports/$reportId" });
  const { t } = useI18n();
  const { orgId } = useReports();
  const report = useQuery({ ...reportQuery(orgId, reportId), enabled: orgId !== "" });
  // The editor starts over from the stored report only when asked to: after a save, and for
  // "load the saved state". Reading the report again for any other reason keeps the draft.
  const [generation, setGeneration] = useState(0);
  if (report.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (report.isError) {
    return (
      <Page title={t("reports.title")}>
        <EmptyState icon="alert" title={t("reports.notFound")}>
          {reportErrorText(t, report.error)}
        </EmptyState>
      </Page>
    );
  }
  return (
    <ReportEditor
      key={`${report.data.id}:${generation}`}
      stored={report.data}
      initial={draftFromReport(report.data)}
      onReload={() => setGeneration((current) => current + 1)}
    />
  );
}

/** Every dashboard the person can read, for the picker: an organization has a few hundred. */
async function allDashboards(orgId: string, signal: AbortSignal) {
  const all: { id: string; title: string }[] = [];
  let cursor: string | undefined;
  do {
    const page = await fetchDashboards(orgId, { cursor }, signal);
    all.push(...page.items.map((item) => ({ id: item.id, title: item.title })));
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return all.sort((a, b) => a.title.localeCompare(b.title));
}

const FORMATS: readonly FormatChoice[] = ["pdf", "csv", "both"];
/** The fields that can carry an error, from the top of the form down. */
const FIELD_ORDER: readonly DraftField[] = [
  "name",
  "dashboardId",
  "panelIds",
  "timeRange",
  "schedule",
  "day",
  "timeZone",
  "recipients",
  "formats",
];
const LANGUAGES: readonly Language[] = ["de", "en"];

/**
 * The report editor (board Reports.dc.html, frames 2 and 3): content, time range and variables,
 * schedule with its time zone, recipients, and format, under each other; the summary, the
 * preview and "send now" on the right. Nothing applies before Save; errors show at their field.
 */
function ReportEditor({
  initial,
  stored,
  onReload,
}: {
  initial: ReportDraft;
  stored?: Report;
  /** Starts the editor over from the stored report. */
  onReload?: () => void;
}) {
  const { t, language } = useI18n();
  const ids = useId();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { orgId, orgName, permissions, status, canWrite, manages } = useReports();
  useDocumentTitle(stored === undefined ? "reports.new" : "reports.title");
  const [draft, setDraft] = useState(initial);
  const [shown, setShown] = useState<DraftErrors>({});
  const [previewing, setPreviewing] = useState<ReportInput | null>(null);
  const [sending, setSending] = useState(false);
  // Pausing and resuming raise the stored version; a later Save sends the one they answered, so
  // it does not conflict with the person's own change. The draft stays as it is.
  const [version, setVersion] = useState(stored?.version);
  const [paused, setPaused] = useState(stored?.paused ?? false);
  // Someone else's report runs with its creator's rights: only the creator and organization
  // admins change, send or delete it; others who write reports may still pause it.
  const owns = stored === undefined || manages(stored);
  const readOnly = !canWrite || !owns;
  const maxRecipients = status?.limits.maxRecipients ?? 20;
  const canCsv = permissions.has("data:export");

  const dashboards = useQuery({
    queryKey: [REPORTS_KEY, orgId, "dashboards"],
    queryFn: ({ signal }) => allDashboards(orgId, signal),
    enabled: orgId !== "",
    staleTime: 60_000,
  });
  const dashboard = useQuery({
    ...dashboardQuery(orgId, draft.dashboardId),
    enabled: orgId !== "" && draft.dashboardId !== "",
  });
  const model = dashboard.data?.model;
  const panels = model === undefined ? [] : readingOrder(model.panels);
  const variables = (model?.variables ?? []).filter((variable) => variable.type !== "constant");
  const multi = new Set(variables.filter((v) => v.multi === true).map((v) => v.name));
  const dashboardTitle =
    model?.title ??
    dashboards.data?.find((item) => item.id === draft.dashboardId)?.title ??
    stored?.dashboardTitle ??
    "";
  const zoneTime = useReportTime(draft.timeZone);
  const schedule = scheduleOf(draft);
  const upcoming = nextRuns(schedule, draft.timeZone, Date.now());

  // The list, the runs and the status only: reading this report anew must not put the stored one over
  // the draft.
  const refreshOthers = () =>
    Promise.all(
      ["list", "runs", "status"].map((part) =>
        queryClient.invalidateQueries({ queryKey: [REPORTS_KEY, orgId, part] }),
      ),
    );
  const save = useMutation({
    mutationFn: () => {
      const input = inputOf(draft, multi, version);
      return stored === undefined
        ? createReport(orgId, input)
        : updateReport(orgId, stored.id, input);
    },
    onSuccess: async (saved) => {
      showToast({ message: t("reports.saved", { name: saved.name }) });
      queryClient.setQueryData([REPORTS_KEY, orgId, "one", saved.id], saved);
      await refreshOthers();
      if (stored === undefined) {
        void navigate({ to: "/reports/$reportId", params: { reportId: saved.id } });
      } else {
        onReload?.();
      }
    },
  });
  const pause = useMutation({
    mutationFn: (paused: boolean) => {
      if (stored === undefined) throw new Error("no stored report");
      return setReportPaused(orgId, stored.id, version ?? stored.version, paused);
    },
    onSuccess: async (saved) => {
      setVersion(saved.version);
      setPaused(saved.paused);
      setDraft((current) => ({ ...current, paused: saved.paused }));
      showToast({
        message: t(saved.paused ? "reports.paused" : "reports.resumed", { name: saved.name }),
      });
      await refreshOthers();
    },
    onError: (error) => showToast({ message: reportErrorText(t, error), error: true }),
  });
  const send = useMutation({
    mutationFn: () => sendNow(orgId, stored?.id ?? ""),
    onSuccess: async () => {
      setSending(false);
      showToast({ message: t("reports.queued", { name: stored?.name ?? "" }) });
      await refreshOthers();
    },
  });

  function update(patch: Partial<ReportDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
  }

  function submit() {
    const errors = validateDraft(draft, maxRecipients);
    setShown(errors);
    // In the order of the form, so focus goes to the first field with a problem.
    const first = FIELD_ORDER.find((field) => errors[field] !== undefined);
    if (first !== undefined) {
      document.getElementById(`${ids}-${first}`)?.focus();
      return;
    }
    save.mutate();
  }

  const conflict = save.isError && isApiError(save.error, "version_conflict");
  // A server reason that belongs to a field shows there; the others above the form.
  const serverField = save.isError && !conflict ? errorField(save.error) : undefined;
  const fieldError = (field: DraftField): string | undefined => {
    const own = shown[field];
    if (own !== undefined) return t(own.key, own.params ?? {});
    if (serverField === field) return reportErrorText(t, save.error);
    return undefined;
  };
  const formError =
    save.isError && !conflict && serverField === undefined ? reportErrorText(t, save.error) : null;

  const title = stored === undefined ? t("reports.new") : stored.name;
  const rangeOptions = [
    ...PRESETS.filter((preset) => preset.fiscal !== true).map((preset) => ({
      value: `${preset.from}|${preset.to}`,
      label: t(preset.label),
    })),
  ];
  if (draft.range !== "" && !rangeOptions.some((option) => option.value === draft.range)) {
    const [from = "", to = ""] = draft.range.split("|");
    rangeOptions.unshift({
      value: draft.range,
      label: rangeLabel(t, language, { from, to }, draft.timeZone),
    });
  }
  // Before a dashboard is chosen its range is not known: the words alone then.
  const ownRange =
    model === undefined
      ? t("reports.variables.saved")
      : t("reports.range.dashboard", {
          range: rangeLabel(t, language, model.timeRange, null),
        });
  const rangeText =
    draft.range === ""
      ? ownRange
      : (rangeOptions.find((option) => option.value === draft.range)?.label ?? "");
  // Members who left the organization: in no run, and gone from the report with the next save.
  const gone = (stored?.recipients ?? []).filter((recipient) => !reachable(recipient)).length;
  const zones = timeZones();
  const sendBlocked = status === undefined || !status.enabled || !status.mailConfigured;
  const csvChosen = draft.format !== "pdf";
  const previewBlocked = draft.dashboardId === "" || status?.enabled === false;

  return (
    <ReportsFrame
      title={title}
      crumbs={[{ label: t("reports.title"), link: { to: "/reports" } }, { label: title }]}
      actions={
        <PageActions>
          <Link to="/reports" className="button button--secondary">
            {t("admin.common.cancel")}
          </Link>
          {stored === undefined || !canWrite || (!owns && paused) ? null : (
            <button
              type="button"
              className="button button--secondary"
              aria-disabled={pause.isPending || undefined}
              onClick={() => !pause.isPending && pause.mutate(!paused)}
            >
              {t(paused ? "reports.menu.resume" : "reports.menu.pause")}
            </button>
          )}
          {readOnly ? null : (
            <button
              type="button"
              className="button button--primary"
              aria-disabled={save.isPending || undefined}
              onClick={() => !save.isPending && submit()}
            >
              {t("admin.common.save")}
            </button>
          )}
        </PageActions>
      }
    >
      {stored === undefined ? null : <ReportTabs reportId={stored.id} />}
      {stored !== undefined && stored.suspended !== null ? (
        <p className="alert-alarm" role="status">
          <Icon name="alert" />
          <span>
            <strong>{t("reports.suspended.name", { name: stored.name })}</strong>{" "}
            {codeText(t, stored.suspended)} {t("reports.suspended.hint")}
          </span>
        </p>
      ) : null}
      {paused ? (
        <p className="alert-note" role="status">
          <Icon name="info" />
          {t("reports.pausedNote")}
        </p>
      ) : null}
      {readOnly ? <p className="alert-note">{t("reports.readOnly")}</p> : null}
      <FormAlert>{formError}</FormAlert>
      <div className="alert-editor">
        <fieldset className="report-form alert-editor__form" disabled={readOnly}>
          <legend className="visually-hidden">{t("reports.tab.settings")}</legend>
          {conflict ? (
            <div className="notice notice--danger" role="alert">
              <Icon name="alert" />
              <div>
                <p>{t("reports.conflict")}</p>
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => {
                    if (stored === undefined) return;
                    void queryClient
                      .refetchQueries({ queryKey: [REPORTS_KEY, orgId, "one", stored.id] })
                      .then(() => onReload?.());
                  }}
                >
                  {t("reports.conflictLoad")}
                </button>
              </div>
            </div>
          ) : null}
          <div className="alert-card alert-pad report-head">
            <Field id={`${ids}-name`} label={t("reports.name")} error={fieldError("name")}>
              <input
                id={`${ids}-name`}
                className="input"
                value={draft.name}
                maxLength={200}
                aria-invalid={fieldError("name") === undefined ? undefined : true}
                onChange={(event) => update({ name: event.target.value })}
              />
            </Field>
            <Field id={`${ids}-description`} label={t("reports.description")}>
              <input
                id={`${ids}-description`}
                className="input"
                value={draft.description}
                maxLength={1000}
                onChange={(event) => update({ description: event.target.value })}
              />
            </Field>
          </div>

          <Step
            number={1}
            title={t("reports.step.content")}
            extra={
              draft.allPanels || panels.length === 0
                ? undefined
                : t("reports.panels.count", { count: draft.panelIds.length, all: panels.length })
            }
          >
            <Field
              id={`${ids}-dashboardId`}
              label={t("reports.dashboard")}
              error={fieldError("dashboardId")}
            >
              <Select
                id={`${ids}-dashboardId`}
                value={draft.dashboardId}
                aria-invalid={fieldError("dashboardId") === undefined ? undefined : true}
                onChange={(id) =>
                  update({ dashboardId: id, panelIds: [], allPanels: true, variables: {} })
                }
              >
                <option value="" hidden>
                  {t("reports.dashboardPick")}
                </option>
                {(dashboards.data ?? []).map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title}
                  </option>
                ))}
                {draft.dashboardId !== "" &&
                dashboards.data?.some((item) => item.id === draft.dashboardId) !== true ? (
                  <option value={draft.dashboardId}>{dashboardTitle}</option>
                ) : null}
              </Select>
            </Field>
            {dashboard.isError ? (
              <p className="field__error" role="alert">
                <Icon name="alert" />
                <span>{t("reports.reason.dashboard_unknown")}</span>
              </p>
            ) : null}
            {draft.dashboardId === "" ? null : (
              <>
                <Segmented
                  label={t("reports.scope")}
                  value={draft.allPanels ? "all" : "some"}
                  options={[
                    { value: "all", label: t("reports.scope.all") },
                    { value: "some", label: t("reports.scope.some") },
                  ]}
                  onChange={(value) => update({ allPanels: value === "all" })}
                />
                {draft.allPanels ? null : (
                  <fieldset
                    className="alert-fieldset"
                    id={`${ids}-panelIds`}
                    tabIndex={-1}
                    aria-describedby={
                      fieldError("panelIds") === undefined ? undefined : `${ids}-panelIds-error`
                    }
                  >
                    <legend className="visually-hidden">{t("reports.scope.some")}</legend>
                    {dashboard.isPending ? <p className="loading">{t("common.loading")}</p> : null}
                    <ul className="alert-pick-list">
                      {panels.map((panel) => (
                        <li key={panel.id}>
                          <label className="alert-pick">
                            <input
                              type="checkbox"
                              checked={draft.panelIds.includes(panel.id)}
                              onChange={(event) => {
                                const chosen = event.currentTarget.checked
                                  ? [...draft.panelIds, panel.id]
                                  : draft.panelIds.filter((id) => id !== panel.id);
                                // In the dashboard's order, as the report shows them.
                                update({
                                  panelIds: panels
                                    .map((item) => item.id)
                                    .filter((id) => chosen.includes(id)),
                                });
                              }}
                            />
                            <span className="alert-pick__name">
                              {panel.title === "" ? t("reports.panels.untitled") : panel.title}
                            </span>
                          </label>
                        </li>
                      ))}
                    </ul>
                    <FieldError id={`${ids}-panelIds-error`} text={fieldError("panelIds")} />
                  </fieldset>
                )}
              </>
            )}
          </Step>

          <Step number={2} title={t("reports.step.range")}>
            <Field
              id={`${ids}-timeRange`}
              label={t("reports.range")}
              hint={t("reports.range.hint")}
              error={fieldError("timeRange")}
            >
              <Select
                id={`${ids}-timeRange`}
                value={draft.range}
                aria-invalid={fieldError("timeRange") === undefined ? undefined : true}
                onChange={(range) => update({ range })}
              >
                <option value="">{ownRange}</option>
                {rangeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            </Field>
            {variables.length === 0 ? null : (
              <div className="alert-grid2">
                {variables.map((variable) => (
                  <VariableField
                    key={variable.name}
                    id={`${ids}-var-${variable.name}`}
                    variable={variable}
                    value={draft.variables[variable.name] ?? ""}
                    onChange={(value) =>
                      update({ variables: { ...draft.variables, [variable.name]: value } })
                    }
                  />
                ))}
              </div>
            )}
          </Step>

          <Step number={3} title={t("reports.col.schedule")}>
            <Segmented
              label={t("reports.col.schedule")}
              value={draft.kind}
              options={SCHEDULE_KINDS.map((kind) => ({
                value: kind,
                label: t(`reports.schedule.${kind}`),
              }))}
              onChange={(kind) => update({ kind })}
            />
            {draft.kind === "weekly" ? (
              // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's field set
              <div className="alert-filters" role="group" aria-label={t("reports.schedule.days")}>
                {WEEKDAYS.map((day) => (
                  <button
                    key={day}
                    type="button"
                    className="alert-filter"
                    aria-pressed={draft.weekdays.includes(day)}
                    title={weekdayName(language, day, "long")}
                    onClick={() =>
                      update({
                        weekdays: draft.weekdays.includes(day)
                          ? draft.weekdays.filter((item) => item !== day)
                          : [...draft.weekdays, day],
                      })
                    }
                  >
                    {weekdayName(language, day, "short")}
                  </button>
                ))}
              </div>
            ) : null}
            <div className="alert-grid3">
              {draft.kind === "cron" ? (
                <Field
                  id={`${ids}-schedule`}
                  label={t("reports.schedule.cron")}
                  hint={t("reports.schedule.cronHint")}
                  error={fieldError("schedule")}
                >
                  <input
                    id={`${ids}-schedule`}
                    className="input input--mono"
                    value={draft.cron}
                    spellCheck={false}
                    aria-invalid={fieldError("schedule") === undefined ? undefined : true}
                    onChange={(event) => update({ cron: event.target.value })}
                  />
                </Field>
              ) : (
                <Field
                  id={`${ids}-schedule`}
                  label={t("reports.schedule.time")}
                  error={fieldError("schedule")}
                >
                  <input
                    id={`${ids}-schedule`}
                    type="time"
                    className="input"
                    value={draft.time}
                    aria-invalid={fieldError("schedule") === undefined ? undefined : true}
                    onChange={(event) => update({ time: event.target.value })}
                  />
                </Field>
              )}
              {draft.kind === "monthly" ? (
                <Field
                  id={`${ids}-day`}
                  label={t("reports.schedule.day")}
                  error={fieldError("day")}
                >
                  <input
                    id={`${ids}-day`}
                    className="input"
                    inputMode="numeric"
                    value={draft.day}
                    aria-invalid={fieldError("day") === undefined ? undefined : true}
                    onChange={(event) => update({ day: event.target.value })}
                  />
                </Field>
              ) : null}
              <Field
                id={`${ids}-timeZone`}
                label={t("reports.schedule.zone")}
                error={fieldError("timeZone")}
              >
                <Select
                  id={`${ids}-timeZone`}
                  value={draft.timeZone}
                  onChange={(timeZone) => update({ timeZone })}
                >
                  {zones.includes(draft.timeZone) ? null : (
                    <option value={draft.timeZone}>{draft.timeZone}</option>
                  )}
                  {zones.map((zone) => (
                    <option key={zone} value={zone}>
                      {zone}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {upcoming.length === 0 ? null : (
              <p className="alert-muted report-next">
                {t("reports.schedule.next", {
                  times: upcoming.map((at) => zoneTime.dayTime(at)).join(" · "),
                })}
              </p>
            )}
          </Step>

          <Step
            number={4}
            title={t("reports.col.recipients")}
            extra={t("reports.recipients.count", {
              count: draft.recipients.length,
              max: maxRecipients,
            })}
          >
            <RecipientsField
              id={`${ids}-recipients`}
              orgId={orgId}
              recipients={draft.recipients}
              onChange={(recipients) => {
                update({ recipients });
                // The server's refusal names a recipient by position; with the list changed it
                // no longer says which one, and the next save asks again.
                if (serverField === "recipients") save.reset();
              }}
              error={fieldError("recipients")}
              errorIndex={serverField === "recipients" ? errorRecipient(save.error) : undefined}
              status={status}
              disabled={readOnly}
            />
            {gone === 0 ? null : (
              <p className="alert-hint">{t("reports.recipients.gone", { count: gone })}</p>
            )}
            <p className="alert-hint">
              {dashboardTitle === ""
                ? null
                : `${t("reports.recipients.hint", { dashboard: dashboardTitle })} `}
              {status?.allowExternalRecipients === true
                ? status.externalDomains.length === 0
                  ? t("reports.recipients.external")
                  : t("reports.recipients.externalDomains", {
                      domains: status.externalDomains.join(", "),
                    })
                : t("reports.recipients.externalOff", { org: orgName })}
            </p>
          </Step>

          <Step number={5} title={t("reports.col.format")}>
            <Segmented
              label={t("reports.col.format")}
              value={draft.format}
              options={FORMATS.map((format) => ({
                value: format,
                label: format === "both" ? t("reports.format.both") : format.toUpperCase(),
                disabled: format !== "pdf" && !canCsv,
              }))}
              onChange={(format) => update({ format })}
            />
            <FieldError id={`${ids}-formats`} text={fieldError("formats")} />
            {canCsv ? null : <p className="alert-hint">{t("reports.reason.csv_needs_export")}</p>}
            <p className="alert-hint">
              {t(csvChosen ? "reports.format.csvNote" : "reports.format.pdfNote")}
            </p>
            <div className="alert-grid2">
              <Field
                id={`${ids}-language`}
                label={t("reports.language")}
                hint={t("reports.language.hint")}
              >
                <Select
                  id={`${ids}-language`}
                  value={draft.language}
                  onChange={(value) => update({ language: value === "de" ? "de" : "en" })}
                >
                  {LANGUAGES.map((code) => (
                    <option key={code} value={code}>
                      {t(`language.${code}`)}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
          </Step>
        </fieldset>

        <aside className="alert-editor__side" aria-label={t("reports.summary")}>
          <section className="alert-card alert-pad">
            <h2 className="alert-step__title">{t("reports.summary")}</h2>
            <dl className="report-summary">
              <dt>{t("reports.step.content")}</dt>
              <dd>
                {draft.dashboardId === ""
                  ? "–"
                  : draft.allPanels
                    ? t("reports.content.all", { dashboard: dashboardTitle })
                    : t("reports.content.panels", {
                        dashboard: dashboardTitle,
                        count: draft.panelIds.length,
                      })}
              </dd>
              <dt>{t("reports.range")}</dt>
              <dd>{rangeText}</dd>
              <dt>{t("reports.summary.when")}</dt>
              <dd>
                {scheduleText(t, language, schedule)}, {draft.timeZone}
              </dd>
              <dt>{t("reports.summary.to")}</dt>
              <dd>{draft.recipients.length === 0 ? "–" : recipientsText(t, draft.recipients)}</dd>
              <dt>{t("reports.col.format")}</dt>
              <dd>
                {formatsText(draft.format === "both" ? ["pdf", "csv"] : [draft.format])}
                {status === undefined
                  ? null
                  : ` · ${t("reports.summary.limit", {
                      size: formatBytes(status.limits.maxAttachmentBytes, language),
                    })}`}
              </dd>
              {stored === undefined || stored.nextRunAt === null ? null : (
                <>
                  <dt>{t("reports.col.next")}</dt>
                  <dd>{zoneTime.dayTime(stored.nextRunAt)}</dd>
                </>
              )}
            </dl>
            {readOnly ? null : (
              <div className="alert-row-actions">
                <button
                  type="button"
                  className="button button--secondary"
                  aria-disabled={previewBlocked || undefined}
                  aria-describedby={previewBlocked ? `${ids}-preview-why` : undefined}
                  onClick={() =>
                    !previewBlocked &&
                    setPreviewing({
                      ...inputOf(draft, multi),
                      name: draft.name.trim() === "" ? t("reports.new") : draft.name.trim(),
                    })
                  }
                >
                  <Icon name="eye" />
                  {t("reports.preview")}
                </button>
                {stored === undefined ? null : (
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-disabled={sendBlocked || undefined}
                    aria-describedby={sendBlocked ? `${ids}-send-why` : undefined}
                    onClick={() => !sendBlocked && setSending(true)}
                  >
                    {t("reports.menu.send")}
                  </button>
                )}
              </div>
            )}
            {!readOnly && draft.dashboardId === "" ? (
              <p className="alert-hint" id={`${ids}-preview-why`}>
                {t("reports.dashboardPick")}
              </p>
            ) : null}
            {!readOnly && stored !== undefined && sendBlocked && status !== undefined ? (
              <p className="alert-hint" id={`${ids}-send-why`}>
                {t(
                  status.enabled ? "reports.reason.mail_not_configured" : "reports.reason.disabled",
                )}
              </p>
            ) : null}
          </section>
          <p className="alert-note report-note">
            <Icon name="info" />
            <span>
              {stored === undefined
                ? t("reports.rights.yours")
                : t("reports.rights.owner", {
                    name: stored.ownerName ?? t("reports.ownerGone"),
                  })}
            </span>
          </p>
          {stored !== undefined && canWrite && !owns ? (
            <p className="alert-hint">
              {stored.ownerName === null
                ? t("reports.reason.not_owner")
                : t("reports.rights.notOwner", { name: stored.ownerName })}
            </p>
          ) : null}
          {stored === undefined && !readOnly ? (
            <p className="alert-hint">{t("reports.tip")}</p>
          ) : null}
        </aside>
      </div>
      {previewing === null ? null : (
        <PreviewDialog
          orgId={orgId}
          input={previewing}
          maxBytes={status?.limits.maxAttachmentBytes}
          onClose={() => setPreviewing(null)}
        />
      )}
      <SendDialog
        report={sending && stored !== undefined ? stored : null}
        busy={send.isPending}
        error={send.isError ? reportErrorText(t, send.error) : null}
        onConfirm={() => send.mutate()}
        onClose={() => {
          setSending(false);
          send.reset();
        }}
      />
    </ReportsFrame>
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
  extra?: string | undefined;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="alert-step" aria-labelledby={id}>
      <div className="alert-step__head">
        <span className="alert-step__num" aria-hidden="true">
          {number}
        </span>
        <h2 className="alert-step__title" id={id}>
          {title}
        </h2>
        {extra === undefined ? null : (
          <>
            <span className="alert-spacer" />
            <span className="alert-muted">{extra}</span>
          </>
        )}
      </div>
      <div className="alert-step__body">{children}</div>
    </section>
  );
}

function FieldError({ id, text }: { id: string; text: string | undefined }) {
  if (text === undefined) return null;
  return (
    <p className="field__error" id={id} role="alert">
      <Icon name="alert" />
      <span>{text}</span>
    </p>
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
      <FieldError id={`${id}-error`} text={error} />
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
    </div>
  );
}

/** A variable's fixed value: its choices where it has some, free text otherwise. */
function VariableField({
  id,
  variable,
  value,
  onChange,
}: {
  id: string;
  variable: VariableModel;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const label =
    variable.label === undefined || variable.label === "" ? variable.name : variable.label;
  const choices =
    variable.multi === true || (variable.type !== "custom" && variable.type !== "interval")
      ? []
      : optionChoices(variable);
  if (choices.length > 0) {
    return (
      <Field id={id} label={label}>
        <Select id={id} value={value} onChange={onChange}>
          <option value="">{t("reports.variables.saved")}</option>
          {choices.some((choice) => choice.value === value) || value === "" ? null : (
            <option value={value}>{value}</option>
          )}
          {choices.map((choice) => (
            <option key={choice.value} value={choice.value}>
              {choice.label}
            </option>
          ))}
        </Select>
      </Field>
    );
  }
  return (
    <Field
      id={id}
      label={label}
      {...(variable.multi === true ? { hint: t("reports.variables.multi") } : {})}
    >
      <input
        id={id}
        className="input"
        value={value}
        placeholder={t("reports.variables.saved")}
        onChange={(event) => onChange(event.target.value)}
      />
    </Field>
  );
}
