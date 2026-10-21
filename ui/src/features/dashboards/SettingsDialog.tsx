import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { datasourcesQuery } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { emptyQuery } from "../datasources/queryKinds";
import {
  type DashboardModel,
  VARIABLE_TYPES,
  type VariableModel,
  type VariableType,
} from "./model";
import { REFRESH_CHOICES } from "./refresh";
import { Dialog } from "./ui/Dialog";

/** Variable names become bind parameters ($name); the server accepts identifiers only. */
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

interface SettingsDialogProps {
  orgId: string;
  model: DashboardModel;
  onApply: (model: DashboardModel) => void;
  onClose: () => void;
}

/** Dashboard settings in edit mode: title, default refresh and the variables. */
export function SettingsDialog({ orgId, model, onApply, onClose }: SettingsDialogProps) {
  const { t } = useI18n();
  const refreshId = useId();
  const formId = useId();
  const [title, setTitle] = useState(model.title);
  const [refresh, setRefresh] = useState(model.refreshSeconds ?? 0);
  const [variables, setVariables] = useState<VariableModel[]>(model.variables);
  // Names change while typing, so editors are keyed by an id that lives only in this dialog.
  const [keys, setKeys] = useState(() => model.variables.map(() => crypto.randomUUID()));
  const [errors, setErrors] = useState<Record<number, string>>({});

  const update = (index: number, patch: Partial<VariableModel>) =>
    setVariables((list) => list.map((v, i) => (i === index ? { ...v, ...patch } : v)));

  function apply() {
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
    if (Object.keys(found).length > 0) {
      return;
    }
    const next: DashboardModel = { ...model, title: title.trim(), variables };
    if (refresh > 0) {
      next.refreshSeconds = refresh;
    } else {
      delete next.refreshSeconds;
    }
    onApply(next);
  }

  return (
    <Dialog
      title={t("dashboards.settings.title")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button type="submit" form={formId} className="button button--primary">
            {t("dashboards.editor.apply")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          apply();
        }}
      >
        <TextField
          label={t("dashboards.settings.dashboardTitle")}
          value={title}
          onValueChange={setTitle}
          autoComplete="off"
          data-autofocus
        />
        <div className="field">
          <label className="field__label" htmlFor={refreshId}>
            {t("dashboards.settings.refresh")}
          </label>
          <select
            id={refreshId}
            className="select"
            value={refresh}
            onChange={(event) => setRefresh(Number(event.currentTarget.value))}
          >
            {REFRESH_CHOICES.map((choice) => (
              <option key={choice.seconds} value={choice.seconds}>
                {t(choice.label)}
              </option>
            ))}
          </select>
        </div>
        <fieldset className="settings__variables">
          <legend className="section-title">{t("dashboards.variables.label")}</legend>
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
              }}
            />
          ))}
          <button
            type="button"
            className="button button--secondary"
            onClick={() => {
              setVariables((list) => [
                ...list,
                { name: `var${list.length + 1}`, type: "custom", values: [] },
              ]);
              setKeys((list) => [...list, crypto.randomUUID()]);
            }}
          >
            {t("dashboards.variables.add")}
          </button>
        </fieldset>
      </form>
    </Dialog>
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
  const [valuesText, setValuesText] = useState((variable.values ?? []).join(", "));
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
            {VARIABLE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`dashboards.variables.type.${type}`)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {variable.type === "custom" ? (
        <TextField
          label={t("dashboards.variables.values")}
          hint={t("dashboards.variables.valuesHint")}
          value={valuesText}
          onValueChange={(text) => {
            // The text stays as typed; a trailing comma is the start of the next value.
            setValuesText(text);
            onChange({
              values: text
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
          <p className="field__hint">{t("dashboards.variables.queryHint")}</p>
        </>
      ) : null}
      <TextField
        label={t("dashboards.variables.default")}
        value={variable.current ?? ""}
        onValueChange={(current) => onChange({ current })}
        autoComplete="off"
      />
      <button type="button" className="button button--ghost" onClick={onRemove}>
        {t("dashboards.variables.remove", { name: variable.name })}
      </button>
    </section>
  );
}
