import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import type { PanelEditorProps } from "../types";
import { ClickVariableOptions } from "../variableClick";
import { MAX_EXPAND_LIMIT } from "./adapter";
import { COMMUNITY_LIMIT } from "./metrics";
import {
  CLUSTER_MODES,
  COLOR_BY,
  type GraphPanelOptions,
  MAX_NODE_LIMIT,
  parseGraphOptions,
} from "./options";
import "./graph.css";
import "../../features/dashboards/ui/shared.css";

/**
 * One line of text. It keeps what is typed (spaces included) and passes it on as it goes; with
 * `required`, an empty field keeps the last value instead.
 */
function TextOption({
  label,
  hint,
  value,
  required = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  required?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      {hint === undefined ? null : (
        <p className="field__hint" id={`${id}-hint`}>
          {hint}
        </p>
      )}
      <input
        id={id}
        className="input input--mono"
        value={text}
        maxLength={100}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (!required || next.trim() !== "") {
            onChange(next);
          }
        }}
      />
    </div>
  );
}

/** A whole number field that keeps what is typed and stores it once it is in range. */
function NumberOption({
  label,
  hint,
  value,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const parsed = Number(text);
  const valid = /^\d+$/.test(text.trim()) && parsed >= 1 && parsed <= max;
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <p className="field__hint" id={`${id}-hint`}>
        {hint}
      </p>
      <input
        id={id}
        className="input"
        inputMode="numeric"
        value={text}
        aria-invalid={valid ? undefined : true}
        aria-describedby={`${id}-hint`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (/^\d+$/.test(next.trim()) && Number(next) >= 1 && Number(next) <= max) {
            onChange(Number(next));
          }
        }}
      />
    </div>
  );
}

/** Options of the network and hierarchy panels. */
export function GraphEditor({
  options,
  onChange,
  network,
}: PanelEditorProps<GraphPanelOptions> & { network: boolean }) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const colorId = useId();
  const sizeId = useId();
  const clusterId = useId();
  const explorerId = useId();
  const variableId = useId();
  const number = new Intl.NumberFormat(language);
  const set = (patch: Partial<GraphPanelOptions>) =>
    onChange(parseGraphOptions({ ...options, ...patch }));
  const sizeMode =
    options.sizeBy === "degree" ? "degree" : options.sizeBy === "" ? "same" : "property";
  const variables = host.variables?.names ?? [];

  return (
    <>
      <TextOption
        label={t("graph.options.caption")}
        hint={t("graph.options.captionHint")}
        value={options.caption}
        onChange={(caption) => set({ caption })}
      />
      <div className="field">
        <label className="field__label" htmlFor={colorId}>
          {t("graph.options.colorBy")}
        </label>
        <p className="field__hint" id={`${colorId}-hint`}>
          {t("graph.options.colorByHint", { limit: number.format(COMMUNITY_LIMIT) })}
        </p>
        <select
          id={colorId}
          className="select"
          value={options.colorBy}
          aria-describedby={`${colorId}-hint`}
          onChange={(event) =>
            set({ colorBy: event.currentTarget.value as GraphPanelOptions["colorBy"] })
          }
        >
          {COLOR_BY.map((mode) => (
            <option key={mode} value={mode}>
              {t(`graph.options.colorBy.${mode}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label className="field__label" htmlFor={sizeId}>
          {t("graph.options.sizeBy")}
        </label>
        <select
          id={sizeId}
          className="select"
          value={sizeMode}
          onChange={(event) => {
            const mode = event.currentTarget.value;
            set({ sizeBy: mode === "degree" ? "degree" : mode === "same" ? "" : "size" });
          }}
        >
          <option value="degree">{t("graph.options.sizeBy.degree")}</option>
          <option value="same">{t("graph.options.sizeBy.same")}</option>
          <option value="property">{t("graph.options.sizeBy.property")}</option>
        </select>
      </div>
      {sizeMode === "property" ? (
        <TextOption
          label={t("graph.options.sizeProperty")}
          value={options.sizeBy}
          required
          onChange={(sizeBy) => set({ sizeBy })}
        />
      ) : null}
      <TextOption
        label={t("graph.options.edgeWidthBy")}
        hint={t("graph.options.edgeWidthByHint")}
        value={options.edgeWidthBy}
        onChange={(edgeWidthBy) => set({ edgeWidthBy })}
      />
      <NumberOption
        label={t("graph.options.nodeLimit")}
        hint={t("graph.options.nodeLimitHint", { max: number.format(MAX_NODE_LIMIT) })}
        value={options.nodeLimit}
        max={MAX_NODE_LIMIT}
        onChange={(nodeLimit) => set({ nodeLimit })}
      />
      {network ? (
        <div className="field">
          <label className="field__label" htmlFor={clusterId}>
            {t("graph.options.cluster")}
          </label>
          <select
            id={clusterId}
            className="select"
            value={options.cluster}
            onChange={(event) =>
              set({ cluster: event.currentTarget.value as GraphPanelOptions["cluster"] })
            }
          >
            {CLUSTER_MODES.map((mode) => (
              <option key={mode} value={mode}>
                {t(`graph.options.cluster.${mode}`)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
      <TextOption
        label={t("graph.options.timeProperty")}
        hint={t("graph.options.timePropertyHint")}
        value={options.timeProperty}
        onChange={(timeProperty) => set({ timeProperty })}
      />
      <label className="checkbox" htmlFor={explorerId}>
        <input
          id={explorerId}
          type="checkbox"
          checked={options.explorer}
          onChange={(event) => set({ explorer: event.currentTarget.checked })}
        />
        {t("graph.options.explorer")}
      </label>
      {options.explorer ? (
        <NumberOption
          label={t("graph.options.expandLimit")}
          hint={t("graph.options.expandLimitHint", { max: number.format(MAX_EXPAND_LIMIT) })}
          value={options.expandLimit}
          max={MAX_EXPAND_LIMIT}
          onChange={(expandLimit) => set({ expandLimit })}
        />
      ) : null}
      <VariableOptions
        id={variableId}
        names={variables}
        options={options}
        onChange={(patch) => set(patch)}
      />
    </>
  );
}

/** Which dashboard variable a click on a node sets, and to which of its properties. */
export function VariableOptions({
  id,
  names,
  options,
  onChange,
}: {
  id: string;
  names: readonly string[];
  options: { variable: string; variableProperty: string };
  onChange: (patch: { variable?: string; variableProperty?: string }) => void;
}) {
  const { t } = useI18n();
  return (
    <ClickVariableOptions
      id={id}
      names={names}
      variable={options.variable}
      source={options.variableProperty}
      texts={{
        trigger: t("graph.options.variable"),
        hint: t("graph.options.variableHint"),
        none: t("graph.options.variableNone"),
        off: t("graph.options.variableOff"),
        source: t("graph.options.variableProperty"),
        sourceHint: t("graph.options.variablePropertyHint"),
      }}
      onChange={(patch) =>
        onChange(
          patch.source === undefined
            ? { variable: patch.variable ?? "" }
            : { variableProperty: patch.source },
        )
      }
    />
  );
}
