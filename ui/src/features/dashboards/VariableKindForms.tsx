import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { Select } from "../../components/Select";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { datasourcesQuery, kindsQuery } from "../datasources/api";
import { AdhocFilters } from "./AdhocFilters";
import { decodeFilters, filtersSupported, isTypedSqlKind, operatorsFor } from "./adhoc";
import { currentValue, filterTexts, type VariableModel } from "./model";
import type { TextRange } from "./timeRange";
import { VariablePreview } from "./VariableOptionsEditor";

/**
 * The forms of the variable kinds that pick no value from a list of their own (board
 * ParityEditors, frame 10): a data source variable, ad hoc filters and a switch.
 */

/** A data source variable: the kind offered, an optional regex on names, the default source. */
export function DatasourceVariableForm({
  orgId,
  dashboardId,
  variable,
  timeRange,
  regexError,
  onRegexError,
  onChange,
}: {
  orgId: string;
  dashboardId: string;
  variable: VariableModel;
  timeRange: TextRange;
  regexError: string | undefined;
  onRegexError: (message: string | undefined) => void;
  onChange: (patch: Partial<VariableModel>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const kinds = useQuery(kindsQuery(orgId));
  const datasources = useQuery(datasourcesQuery(orgId));
  const kind = variable.datasourceKind ?? "";
  // Kinds that have sources first; the list of every kind the server knows is long.
  const used = new Set((datasources.data ?? []).map((d) => d.kind));
  const kindChoices = (kinds.data ?? [])
    .filter((k) => used.has(k.kind) || k.kind === kind)
    .map((k) => ({ kind: k.kind, name: k.name }));
  if (kind !== "" && !kindChoices.some((k) => k.kind === kind)) {
    kindChoices.unshift({ kind, name: kind });
  }
  const ofKind = (datasources.data ?? []).filter((d) => d.kind === kind);
  const current = currentValue(variable) ?? "";
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-kind`}>
          {t("dashboards.variables.datasourceKind")}
        </label>
        <Select
          id={`${id}-kind`}
          value={kind}
          onChange={(next) => {
            // The default must be a source of the new kind: the first one, until one is picked.
            const first = (datasources.data ?? []).find((d) => d.kind === next)?.id;
            onChange({ datasourceKind: next, current: first ?? "" });
          }}
        >
          {kind === "" ? <option value="">{t("dashboards.variables.pickKind")}</option> : null}
          {kindChoices.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.name}
            </option>
          ))}
        </Select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-default`}>
          {t("dashboards.variables.defaultSource")}
        </label>
        <Select
          id={`${id}-default`}
          value={current}
          aria-describedby={`${id}-default-hint`}
          onChange={(next) => onChange({ current: next })}
        >
          {current === "" || !ofKind.some((d) => d.id === current) ? (
            <option value={current}>
              {current === "" ? t("dashboards.editor.pickDatasource") : current}
            </option>
          ) : null}
          {ofKind.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <p className="field__hint" id={`${id}-default-hint`}>
          {t("dashboards.variables.defaultSourceHint", { name: variable.name })}
        </p>
      </div>
      <TextField
        label={t("dashboards.variables.sourceRegex")}
        hint={t("dashboards.variables.sourceRegexHint")}
        value={variable.regex ?? ""}
        onValueChange={(regex) => onChange({ regex })}
        error={regexError}
        mono
        autoComplete="off"
      />
      {kind === "" || current === "" ? null : (
        <VariablePreview
          orgId={orgId}
          variable={variable}
          timeRange={timeRange}
          values={{}}
          dashboardId={dashboardId}
          onRegexError={onRegexError}
        />
      )}
    </>
  );
}

/** Ad hoc filters: the source they narrow and the filters the dashboard opens with. */
export function AdhocVariableForm({
  orgId,
  variable,
  room,
  onChange,
}: {
  orgId: string;
  variable: VariableModel;
  /** How many more filters the dashboard may hold over all its ad hoc variables. */
  room: number;
  onChange: (patch: Partial<VariableModel>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const datasources = useQuery(datasourcesQuery(orgId));
  const sources = (datasources.data ?? []).filter(
    (d) => filtersSupported(d.kind) || d.id === variable.datasourceId,
  );
  const source = datasources.data?.find((d) => d.id === variable.datasourceId);
  const texts = filterTexts(variable);
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-ds`}>
          {t("dashboards.editor.datasource")}
        </label>
        <Select
          id={`${id}-ds`}
          value={variable.datasourceId ?? ""}
          aria-describedby={`${id}-ds-hint`}
          onChange={(datasourceId) => onChange({ datasourceId })}
        >
          <option value="">{t("dashboards.editor.pickDatasource")}</option>
          {sources.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </Select>
        <p className="field__hint" id={`${id}-ds-hint`}>
          {isTypedSqlKind(source?.kind)
            ? t("dashboards.variables.adhocSqlHint")
            : t("dashboards.variables.adhocHint")}
        </p>
      </div>
      <div className="field variable-editor__filters">
        <span className="field__label">{t("dashboards.variables.adhocStart")}</span>
        <div className="dash-filters">
          <div className="variables">
            <AdhocFilters
              label={variable.label || variable.name}
              value={texts}
              operators={operatorsFor(source?.kind)}
              room={room}
              onChange={(next) => onChange({ current: decodeFilters(next) })}
            />
          </div>
        </div>
      </div>
    </>
  );
}

/** A switch: the value it sends when on and when off, and how the dashboard opens. */
export function SwitchVariableForm({
  variable,
  onChange,
}: {
  variable: VariableModel;
  onChange: (patch: Partial<VariableModel>) => void;
}) {
  const { t } = useI18n();
  const onValue = variable.onValue ?? "";
  const offValue = variable.offValue ?? "";
  const opensOn = currentValue(variable) === onValue && onValue !== "";
  const same = onValue === offValue;
  return (
    <>
      <div className="variable-editor__row">
        <TextField
          label={t("dashboards.variables.onValue")}
          value={onValue}
          onValueChange={(next) =>
            onChange({ onValue: next, ...(opensOn ? { current: next } : {}) })
          }
          error={same ? t("dashboards.variables.switchSame") : undefined}
          autoComplete="off"
        />
        <TextField
          label={t("dashboards.variables.offValue")}
          value={offValue}
          onValueChange={(next) =>
            onChange({ offValue: next, ...(opensOn ? {} : { current: next }) })
          }
          autoComplete="off"
        />
      </div>
      <label className="variable-editor__switch">
        {t("dashboards.variables.opensOn")}
        <input
          type="checkbox"
          role="switch"
          className="settings-switch"
          checked={opensOn}
          aria-checked={opensOn}
          onChange={(event) =>
            onChange({ current: event.currentTarget.checked ? onValue : offValue })
          }
        />
      </label>
    </>
  );
}
