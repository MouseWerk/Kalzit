import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Breadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { datasourcesQuery, kindsQuery } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { emptyQuery } from "../datasources/queryKinds";
import {
  type AnnotationQueryModel,
  cleanVariable,
  currentValue,
  currentValues,
  type DashboardLinkModel,
  type DashboardModel,
  optionValues,
  VALUES_SOURCES,
  VARIABLE_TYPES,
  type ValuesFrom,
  type VariableModel,
  type VariableType,
} from "./model";
import { intervalLabel, refreshIntervals } from "./refresh";
import { AnnotationQueriesEditor, LinksEditor, linkProblem, parseTags } from "./SettingsParts";
import {
  applyTimeOptions,
  parseIntervals,
  TimeOptionsEditor,
  timeOptionsDraft,
  timeOptionsProblems,
} from "./TimeOptionsEditor";
import "./dashboards.css";
import "./dashboardTools.css";

/** Variable names become bind parameters ($name); the server accepts identifiers only. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const SETTINGS_SECTIONS = [
  "general",
  "variables",
  "annotations",
  "links",
  "time",
  "access",
  "versions",
  "json",
] as const;
export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

const SECTION_LABEL: Record<SettingsSection, MessageKey> = {
  general: "dashboards.settingsPage.section.general",
  variables: "dashboards.settingsPage.section.variables",
  annotations: "dashboards.settingsPage.section.annotations",
  links: "dashboards.settingsPage.section.links",
  time: "dashboards.settingsPage.section.time",
  access: "dashboards.settingsPage.section.access",
  versions: "dashboards.settingsPage.section.versions",
  json: "dashboards.settingsPage.section.json",
};

interface DashboardSettingsPageProps {
  orgId: string;
  dashboardId: string;
  /** The dashboard as it is now: the edit draft when there is one, else the saved version. */
  model: DashboardModel;
  /** The newest saved version, for the Versions section. */
  version: number;
  section: SettingsSection;
  /** The way to the dashboard, for the breadcrumbs. */
  trail: Crumb[];
  canEdit: boolean;
  /** The dashboard itself has unsaved changes (edit mode): Save saves them too. */
  unsaved: boolean;
  /** The dashboard's access button, or null when the caller may not manage access. */
  access: ReactNode;
  /**
   * Saves the changed dashboard (the page then asks for a message, as Save does), on the version
   * the page started from, so a version saved elsewhere meanwhile is not overwritten unasked.
   */
  onSave: (next: DashboardModel, base: number) => void;
  /** Told whenever the page gets or loses changes; the dashboard's leave guard asks for them. */
  onDirtyChange: (dirty: boolean) => void;
  /**
   * In edit mode: takes the settings into the unsaved dashboard and goes back to it, as the panel
   * editor's Apply does; left out outside edit mode.
   */
  onApply?: ((next: DashboardModel) => void) | undefined;
  /** Opens the JSON model, starting from the dashboard with this page's changes. */
  onJson: (pending: DashboardModel) => void;
}

/**
 * The dashboard's settings as a page of their own, after the settings page: a navigation of
 * sections on the left (a select on phones), the section on the right, and Save and Discard at
 * the top. Leaving with changes asks first.
 */
export function DashboardSettingsPage({
  orgId,
  dashboardId,
  model,
  version,
  section,
  trail,
  canEdit,
  unsaved,
  access,
  onSave,
  onDirtyChange,
  onApply,
  onJson,
}: DashboardSettingsPageProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const refreshId = useId();
  const ids = useId();
  const [title, setTitle] = useState(model.title);
  const [refresh, setRefresh] = useState(model.refreshSeconds ?? 0);
  const [variables, setVariables] = useState<VariableModel[]>(model.variables);
  // Names change while typing, so editors are keyed by an id that lives only on this page.
  const [keys, setKeys] = useState(() => model.variables.map(() => crypto.randomUUID()));
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [tags, setTags] = useState((model.tags ?? []).join(", "));
  const [links, setLinks] = useState<DashboardLinkModel[]>(model.links ?? []);
  const [annotations, setAnnotations] = useState<AnnotationQueryModel[]>(model.annotations ?? []);
  const [checked, setChecked] = useState(false);
  const [time, setTime] = useState(() => timeOptionsDraft(model));
  const [dirty, setDirty] = useState(false);
  // The version this page started from; one saved elsewhere since is said, and Save asks.
  const [base] = useState(version);
  useEffect(() => {
    onDirtyChange(dirty);
  }, [dirty, onDirtyChange]);
  // Gone from the page (to the dashboard or elsewhere): nothing of it is pending any more.
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const annotationsBad = annotations.some((a) => a.datasourceId === "" || a.name.trim() === "");
  const listRef = useRef<HTMLUListElement>(null);
  const timeProblems = checked ? timeOptionsProblems(t, time) : {};
  // The default refresh offers the intervals typed here, as the toolbar will.
  const typedIntervals = parseIntervals(t, time.intervals);
  const intervalChoices = [
    0,
    ...refreshIntervals(typedIntervals.ok ? typedIntervals.seconds : undefined, refresh),
  ];

  /** Every change marks the page as changed, so leaving asks first. */
  function changed<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setDirty(true);
    };
  }
  const update = (index: number, patch: Partial<VariableModel>) => {
    setVariables((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)));
    setDirty(true);
  };
  const goTo = (next: SettingsSection) =>
    void navigate({
      to: "/dashboards/$dashboardId/settings",
      params: { dashboardId },
      search: (prev) => ({ ...prev, section: next === "general" ? undefined : next }),
    });
  // Back, or Discard with changes: leaving on purpose drops them without asking again.
  const back = () => {
    onDirtyChange(false);
    void navigate({
      to: "/dashboards/$dashboardId",
      params: { dashboardId },
      search: (prev) => ({ ...prev, section: undefined }),
    });
  };

  /** The dashboard with these settings, or null when one needs a look (its section opens). */
  function build(): DashboardModel | null {
    const found: Record<number, string> = {};
    const names = new Set<string>();
    variables.forEach((variable, index) => {
      if (!VARIABLE_NAME.test(variable.name)) {
        found[index] = t("dashboards.variables.nameInvalid");
      } else if (names.has(variable.name)) {
        found[index] = t("dashboards.variables.nameTaken");
      }
      names.add(variable.name);
    });
    setErrors(found);
    setChecked(true);
    const linksBad = links.some((link) => linkProblem(link) !== null);
    const timeBad = Object.keys(timeOptionsProblems(t, time)).length > 0;
    // The first section with a problem opens, so the problem is in view.
    const bad: SettingsSection | undefined =
      Object.keys(found).length > 0
        ? "variables"
        : annotationsBad
          ? "annotations"
          : linksBad
            ? "links"
            : timeBad
              ? "time"
              : undefined;
    if (bad !== undefined) {
      goTo(bad);
      return null;
    }
    const next: DashboardModel = applyTimeOptions(
      t,
      {
        ...model,
        title: title.trim(),
        variables: variables.map(cleanVariable),
      },
      time,
    );
    if (refresh > 0) {
      next.refreshSeconds = refresh;
    } else {
      delete next.refreshSeconds;
    }
    const tagList = parseTags(tags);
    const parts = { tags: tagList, links, annotations } as const;
    for (const [key, list] of Object.entries(parts) as [keyof typeof parts, unknown[]][]) {
      if (list.length > 0) {
        Object.assign(next, { [key]: list });
      } else {
        delete next[key];
      }
    }
    return next;
  }

  // Apply leaves for the dashboard with the change in it: nothing is pending here any more.
  function apply(then: (next: DashboardModel) => void) {
    const next = build();
    if (next === null) {
      return;
    }
    setDirty(false);
    onDirtyChange(false);
    then(next);
  }

  // Save keeps the changes marked until the save went through: a cancelled save dialog leaves
  // them unsaved.
  function save() {
    const next = build();
    if (next !== null) {
      onSave(next, base);
    }
  }

  function openJson() {
    const next = build();
    if (next !== null) {
      onJson(next);
    }
  }

  function onListKey(event: KeyboardEvent<HTMLUListElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") {
      return;
    }
    const items = [...(listRef.current?.querySelectorAll<HTMLAnchorElement>("a") ?? [])];
    const index = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (index === -1) {
      return;
    }
    event.preventDefault();
    items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  }

  let body: ReactNode = null;
  switch (section) {
    case "general":
      body = (
        <div className="form">
          <TextField
            label={t("dashboards.settings.dashboardTitle")}
            value={title}
            onValueChange={changed(setTitle)}
            autoComplete="off"
          />
          <TextField
            label={t("dashboardTools.tags.label")}
            hint={t("dashboardTools.tags.hint")}
            value={tags}
            onValueChange={changed(setTags)}
            autoComplete="off"
          />
          <div className="field">
            <label className="field__label" htmlFor={refreshId}>
              {t("dashboards.settings.refresh")}
            </label>
            <select
              id={refreshId}
              className="select"
              value={refresh}
              onChange={(event) => changed(setRefresh)(Number(event.currentTarget.value))}
            >
              {intervalChoices.map((seconds) => (
                <option key={seconds} value={seconds}>
                  {intervalLabel(t, seconds)}
                </option>
              ))}
            </select>
          </div>
        </div>
      );
      break;
    case "variables":
      body = (
        <div className="settings__variables">
          <p className="field__hint">{t("dashboards.variables.hint")}</p>
          {variables.map((variable, index) => (
            <VariableEditor
              key={keys[index]}
              orgId={orgId}
              variable={variable}
              error={errors[index]}
              onChange={(patch) => update(index, patch)}
              onRemove={() => {
                setVariables((list) => list.filter((_, i) => i !== index));
                setKeys((list) => list.filter((_, i) => i !== index));
                setErrors({});
                setDirty(true);
              }}
            />
          ))}
          <button
            type="button"
            className="button button--secondary dash-settings__add"
            onClick={() => {
              setVariables((list) => [
                ...list,
                { name: `var${list.length + 1}`, type: "custom", options: [] },
              ]);
              setKeys((list) => [...list, crypto.randomUUID()]);
              setDirty(true);
            }}
          >
            <Icon name="plus" />
            {t("dashboards.variables.add")}
          </button>
        </div>
      );
      break;
    case "annotations":
      body = (
        <>
          <AnnotationQueriesEditor
            orgId={orgId}
            queries={annotations}
            onChange={changed(setAnnotations)}
          />
          {checked && annotationsBad ? (
            <p className="notice notice--danger" role="alert">
              {t("annotations.queries.incomplete")}
            </p>
          ) : null}
        </>
      );
      break;
    case "links":
      body = <LinksEditor links={links} onChange={changed(setLinks)} showErrors={checked} />;
      break;
    case "time":
      body = (
        <TimeOptionsEditor
          draft={time}
          onChange={(patch) => {
            setTime((current) => ({ ...current, ...patch }));
            setDirty(true);
          }}
          problems={timeProblems}
        />
      );
      break;
    case "access":
      body = (
        <div className="dash-settings__plain">
          <p>{t("dashboards.settingsPage.accessText")}</p>
          {access ?? <p className="field__hint">{t("dashboards.settingsPage.noAccess")}</p>}
        </div>
      );
      break;
    case "versions":
      body = (
        <div className="dash-settings__plain">
          <p>{t("dashboards.settingsPage.versionsText", { version })}</p>
          <Link
            to="/dashboards/$dashboardId/versions"
            params={{ dashboardId }}
            className="button button--secondary"
          >
            <Icon name="history" />
            {t("dashboards.settingsPage.versionsOpen")}
          </Link>
        </div>
      );
      break;
    case "json":
      body = (
        <div className="dash-settings__plain">
          <p>{t("dashboards.settingsPage.jsonText")}</p>
          <button type="button" className="button button--secondary" onClick={openJson}>
            <Icon name="code" />
            {t("dashboardTools.json.open")}
          </button>
        </div>
      );
      break;
  }

  // Sections that only show or open something keep their content usable for viewers.
  const editable = section !== "access" && section !== "versions" && section !== "json";
  return (
    <>
      <Breadcrumbs crumbs={[...trail, { label: t("dashboards.settings.title") }]} />
      <div className="page dash-settings">
        <div className="page__top">
          <div className="page__header">
            <h1>{t("dashboards.settings.title")}</h1>
            <p className="page__lead">{model.title}</p>
          </div>
          <div className="page__actions">
            {dirty || unsaved ? (
              <span className="dash-settings__unsaved" role="status">
                {t("dashboards.settingsPage.unsaved")}
              </span>
            ) : null}
            <button type="button" className="button button--secondary" onClick={back}>
              {dirty ? t("dashboards.settingsPage.discard") : t("dashboards.settingsPage.back")}
            </button>
            {canEdit && onApply !== undefined ? (
              <button
                type="button"
                className="button button--secondary"
                disabled={!dirty}
                onClick={() => apply(onApply)}
              >
                {t("dashboards.editor.apply")}
              </button>
            ) : null}
            {canEdit ? (
              <button
                type="button"
                className="button button--primary"
                disabled={!dirty && !unsaved}
                onClick={save}
              >
                {t("dashboards.settingsPage.save")}
              </button>
            ) : null}
          </div>
        </div>
        <div className="dash-settings__layout">
          <nav className="dash-settings__nav" aria-label={t("dashboards.settingsPage.nav")}>
            <label className="dash-settings__select field">
              <span className="field__label">{t("dashboards.settingsPage.sectionSelect")}</span>
              <select
                className="select"
                value={section}
                onChange={(event) => goTo(event.currentTarget.value as SettingsSection)}
              >
                {SETTINGS_SECTIONS.map((name) => (
                  <option key={name} value={name}>
                    {t(SECTION_LABEL[name])}
                  </option>
                ))}
              </select>
            </label>
            <ul className="dash-settings__list" ref={listRef} onKeyDown={onListKey}>
              {SETTINGS_SECTIONS.map((name) => (
                <li key={name}>
                  <Link
                    to="/dashboards/$dashboardId/settings"
                    params={{ dashboardId }}
                    search={(prev) => ({ ...prev, section: name === "general" ? undefined : name })}
                    className="dash-settings__link"
                    aria-current={name === section ? "page" : undefined}
                  >
                    {t(SECTION_LABEL[name])}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
          <section className="dash-settings__section" aria-labelledby={`${ids}-section`}>
            <h2 id={`${ids}-section`} className="dash-settings__title">
              {t(SECTION_LABEL[section])}
            </h2>
            {canEdit || !editable ? null : (
              <p className="field__hint">{t("dashboards.settingsPage.readOnly")}</p>
            )}
            {version === base || !dirty ? null : (
              <p className="notice" role="status">
                <Icon name="alert" />
                <span>{t("dashboards.settingsPage.changedElsewhere")}</span>
              </p>
            )}
            {/* Inert as well: a query editor is no form field a fieldset could disable. */}
            <fieldset
              className="dash-settings__body"
              disabled={!canEdit && editable}
              inert={!canEdit && editable}
            >
              {body}
            </fieldset>
          </section>
        </div>
      </div>
    </>
  );
}

/**
 * Where a query variable's values come from when its source answers a graph or documents: the
 * first column of a table (the default), node or edge properties, or a document field. A result
 * keeps its shape, so this is the visible step that turns it into a list of values.
 */
function ValuesFromEditor({
  orgId,
  kind,
  valuesFrom,
  onChange,
}: {
  orgId: string;
  kind: string;
  valuesFrom: ValuesFrom | undefined;
  onChange: (valuesFrom: ValuesFrom | undefined) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const kinds = useQuery(kindsQuery(orgId));
  const shapes = kinds.data?.find((k) => k.kind === kind)?.shapes ?? [];
  const sources = VALUES_SOURCES.filter((source) =>
    source === "documents" ? shapes.includes("documents") : shapes.includes("graph"),
  );
  if (sources.length === 0 && valuesFrom === undefined) {
    return null;
  }
  const choices =
    valuesFrom === undefined || sources.includes(valuesFrom.from)
      ? sources
      : [valuesFrom.from, ...sources];
  const set = (patch: Partial<ValuesFrom>) => {
    if (valuesFrom === undefined) return;
    const next: ValuesFrom = { from: valuesFrom.from };
    for (const key of ["label", "value", "text"] as const) {
      const text = key in patch ? patch[key] : valuesFrom[key];
      if (text !== undefined && text !== "") next[key] = text;
    }
    onChange(next);
  };
  const graph = valuesFrom !== undefined && valuesFrom.from !== "documents";
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {t("dashboards.variables.valuesFrom")}
        </label>
        <p className="field__hint" id={`${id}-hint`}>
          {t("dashboards.variables.valuesFromHint")}
        </p>
        <select
          id={id}
          className="select"
          value={valuesFrom?.from ?? ""}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            const from = VALUES_SOURCES.find((s) => s === event.currentTarget.value);
            onChange(from === undefined ? undefined : { from });
          }}
        >
          <option value="">{t("dashboards.variables.valuesFrom.frame")}</option>
          {choices.map((source) => (
            <option key={source} value={source}>
              {t(`dashboards.variables.valuesFrom.${source}`)}
            </option>
          ))}
        </select>
      </div>
      {graph ? (
        <TextField
          label={
            valuesFrom.from === "nodes"
              ? t("dashboards.variables.valuesFrom.nodeLabel")
              : t("dashboards.variables.valuesFrom.edgeType")
          }
          value={valuesFrom.label ?? ""}
          onValueChange={(label) => set({ label })}
          maxLength={500}
          mono
          autoComplete="off"
        />
      ) : null}
      {valuesFrom === undefined ? null : (
        <>
          <TextField
            label={
              graph
                ? t("dashboards.variables.valuesFrom.property")
                : t("dashboards.variables.valuesFrom.path")
            }
            hint={
              graph
                ? t("dashboards.variables.valuesFrom.propertyHint")
                : t("dashboards.variables.valuesFrom.pathHint")
            }
            value={valuesFrom.value ?? ""}
            onValueChange={(value) => set({ value })}
            maxLength={500}
            mono
            autoComplete="off"
          />
          <TextField
            label={t("dashboards.variables.valuesFrom.text")}
            hint={t("dashboards.variables.valuesFrom.textHint")}
            value={valuesFrom.text ?? ""}
            onValueChange={(text) => set({ text })}
            maxLength={500}
            mono
            autoComplete="off"
          />
        </>
      )}
    </>
  );
}

function VariableEditor({
  orgId,
  variable,
  error,
  onChange,
  onRemove,
}: {
  orgId: string;
  variable: VariableModel;
  error: string | undefined;
  onChange: (patch: Partial<VariableModel>) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const datasources = useQuery({ ...datasourcesQuery(orgId), enabled: variable.type === "query" });
  const datasource = datasources.data?.find((d) => d.id === variable.datasourceId);
  const [valuesText, setValuesText] = useState(optionValues(variable).join(", "));
  const [defaultText, setDefaultText] = useState(currentValues(variable).join(", "));
  return (
    <section className="variable-editor" aria-label={variable.name}>
      <div className="variable-editor__row">
        <TextField
          label={t("dashboards.variables.name")}
          value={variable.name}
          onValueChange={(name) => onChange({ name })}
          error={error}
          mono
          autoComplete="off"
        />
        <TextField
          label={t("dashboards.variables.labelField")}
          value={variable.label ?? ""}
          onValueChange={(label) => onChange({ label })}
          autoComplete="off"
        />
        <div className="field">
          <label className="field__label" htmlFor={`${id}-type`}>
            {t("dashboards.variables.type")}
          </label>
          <select
            id={`${id}-type`}
            className="select"
            value={variable.type}
            onChange={(event) => onChange({ type: event.currentTarget.value as VariableType })}
          >
            {(VARIABLE_TYPES as readonly VariableType[]).includes(variable.type) ? null : (
              <option value={variable.type}>{variable.type}</option>
            )}
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`dashboards.variables.type.${type}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {variable.type === "custom" || variable.type === "interval" ? (
        <TextField
          label={t("dashboards.variables.values")}
          hint={t("dashboards.variables.valuesHint")}
          value={valuesText}
          onValueChange={(text) => {
            // The text stays as typed; a trailing comma is the start of the next value.
            setValuesText(text);
            onChange({
              options: text
                .split(",")
                .map((v) => v.trim())
                .filter((v) => v !== ""),
            });
          }}
          autoComplete="off"
        />
      ) : null}
      {variable.type === "query" ? (
        <>
          <div className="field">
            <label className="field__label" htmlFor={`${id}-ds`}>
              {t("dashboards.editor.datasource")}
            </label>
            <select
              id={`${id}-ds`}
              className="select"
              value={variable.datasourceId ?? ""}
              onChange={(event) => {
                const next = datasources.data?.find((d) => d.id === event.currentTarget.value);
                onChange({
                  datasourceId: event.currentTarget.value,
                  query: emptyQuery(next?.kind ?? ""),
                });
              }}
            >
              <option value="">{t("dashboards.editor.pickDatasource")}</option>
              {(datasources.data ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          {datasource === undefined ? null : (
            <QueryEditor
              orgId={orgId}
              datasource={datasource}
              query={variable.query}
              onChange={(query) => onChange({ query })}
            />
          )}
          {datasource === undefined ? null : (
            <ValuesFromEditor
              orgId={orgId}
              kind={datasource.kind}
              valuesFrom={variable.valuesFrom}
              onChange={(valuesFrom) => onChange({ valuesFrom })}
            />
          )}
          {variable.valuesFrom === undefined ? (
            <p className="field__hint">{t("dashboards.variables.queryHint")}</p>
          ) : null}
        </>
      ) : null}
      {variable.type === "custom" || variable.type === "query" ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={variable.multi === true}
            onChange={(event) => {
              const multi = event.currentTarget.checked;
              onChange({
                multi,
                current: multi ? currentValues(variable) : (currentValue(variable) ?? ""),
              });
            }}
          />
          {t("dashboardTools.variables.multi")}
        </label>
      ) : null}
      {variable.multi === true ? (
        <TextField
          label={t("dashboards.variables.default")}
          hint={t("dashboardTools.variables.multiDefaultHint")}
          value={defaultText}
          onValueChange={(text) => {
            setDefaultText(text);
            onChange({ current: parseTags(text) });
          }}
          autoComplete="off"
        />
      ) : (
        <TextField
          label={t("dashboards.variables.default")}
          value={currentValue(variable) ?? ""}
          onValueChange={(current) => onChange({ current })}
          autoComplete="off"
        />
      )}
      <button type="button" className="button button--ghost" onClick={onRemove}>
        {t("dashboards.variables.remove", { name: variable.name })}
      </button>
    </section>
  );
}
