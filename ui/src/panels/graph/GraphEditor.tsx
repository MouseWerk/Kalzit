import { type ReactNode, useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { usePanelHost } from "../host";
import type { PanelEditorProps } from "../types";
import { ClickVariableOptions } from "../variableClick";
import { MAX_EXPAND_LIMIT } from "./adapter";
import { COMMUNITY_LIMIT } from "./metrics";
import {
  CLICK_ACTIONS,
  CLUSTER_MODES,
  COLOR_BY,
  COLOR_RANGES,
  COLOR_SCHEMES,
  type GraphPanelOptions,
  LABEL_MODES,
  LABEL_TONES,
  MAX_LABEL_TOP,
  MAX_NODE_LIMIT,
  MAX_SIZE,
  MIN_SIZE,
  parseGraphOptions,
  SHOW_WHEN,
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
  min = 1,
  max,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  min?: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  const [text, setText] = useState(String(value));
  const parsed = Number(text);
  const valid = /^\d+$/.test(text.trim()) && parsed >= min && parsed <= max;
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
          if (/^\d+$/.test(next.trim()) && Number(next) >= min && Number(next) <= max) {
            onChange(Number(next));
          }
        }}
      />
    </div>
  );
}

/** A select of fixed choices, each with its catalog text. */
function ChoiceOption<T extends string>({
  label,
  hint,
  value,
  choices,
  text,
  onChange,
}: {
  label: string;
  hint?: string;
  value: T;
  choices: readonly T[];
  text: (choice: T) => string;
  onChange: (value: T) => void;
}) {
  const id = useId();
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
      <select
        id={id}
        className="select"
        value={value}
        aria-describedby={hint === undefined ? undefined : `${id}-hint`}
        onChange={(event) => onChange(event.currentTarget.value as T)}
      >
        {choices.map((choice) => (
          <option key={choice} value={choice}>
            {text(choice)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** A number field that may stay empty (null), for the ends of a fixed color range. */
function OptionalNumber({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number | null;
  onChange: (value: number | null) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value === null ? "" : String(value));
  const valid = text.trim() === "" || Number.isFinite(Number(text));
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        inputMode="decimal"
        value={text}
        aria-invalid={valid ? undefined : true}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (next.trim() === "") onChange(null);
          else if (Number.isFinite(Number(next))) onChange(Number(next));
        }}
      />
    </div>
  );
}

/** A group of options under a heading, as the panel editor board groups them. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <fieldset className="graph-options__group">
      <legend className="graph-options__legend">{title}</legend>
      {children}
    </fieldset>
  );
}

/**
 * Options of the network and hierarchy panels (Graph board, frame 4): nodes (name, color by
 * label, property, community or component, a color per label, size and its range), edges (width,
 * arrows, type labels), labels, the click on a node, the explorer, limits and groups, time.
 */
export function GraphEditor({
  options,
  onChange,
  graphLabels = [],
  network,
}: PanelEditorProps<GraphPanelOptions> & { network: boolean }) {
  const { t, language } = useI18n();
  const host = usePanelHost();
  const explorerId = useId();
  const detailsId = useId();
  const variableId = useId();
  const number = new Intl.NumberFormat(language);
  const set = (patch: Partial<GraphPanelOptions>) =>
    onChange(parseGraphOptions({ ...options, ...patch }));
  const sizeMode =
    options.sizeBy === "degree" ? "degree" : options.sizeBy === "" ? "same" : "property";
  // Single- and multi-value variables: a selection of nodes sets the multi-value ones.
  const variables = [
    ...new Set([...(host.variables?.names ?? []), ...(host.variables?.multi ?? [])]),
  ];
  // Labels of the preview, and labels with a color of their own that the preview lacks.
  const labels = [
    ...graphLabels,
    ...Object.keys(options.labelColors)
      .filter((label) => !graphLabels.some((l) => l.label === label))
      .map((label) => ({ label, count: 0 })),
  ].filter((l) => l.label !== "");

  return (
    <>
      <Group title={t("graph.options.group.nodes")}>
        <TextOption
          label={t("graph.options.caption")}
          hint={t("graph.options.captionHint")}
          value={options.caption}
          onChange={(caption) => set({ caption })}
        />
        <ChoiceOption
          label={t("graph.options.colorBy")}
          hint={t("graph.options.colorByHint", { limit: number.format(COMMUNITY_LIMIT) })}
          value={options.colorBy}
          choices={COLOR_BY}
          text={(mode) => t(`graph.options.colorBy.${mode}`)}
          onChange={(colorBy) => set({ colorBy })}
        />
        {options.colorBy === "label" && labels.length > 0 ? (
          <LabelColors
            labels={labels}
            colors={options.labelColors}
            onChange={(labelColors) => set({ labelColors })}
          />
        ) : null}
        {options.colorBy === "property" ? (
          <>
            <TextOption
              label={t("graph.options.colorProperty")}
              value={options.colorProperty}
              required
              onChange={(colorProperty) => set({ colorProperty })}
            />
            <ChoiceOption
              label={t("graph.options.colorScheme")}
              hint={t("graph.options.colorSchemeHint")}
              value={options.colorScheme}
              choices={COLOR_SCHEMES}
              text={(scheme) => t(`graph.options.colorScheme.${scheme}`)}
              onChange={(colorScheme) => set({ colorScheme })}
            />
            {options.colorScheme === "values" ? null : (
              <>
                <ChoiceOption
                  label={t("graph.options.colorRange")}
                  value={options.colorRange}
                  choices={COLOR_RANGES}
                  text={(range) => t(`graph.options.colorRange.${range}`)}
                  onChange={(colorRange) => set({ colorRange })}
                />
                {options.colorRange === "fixed" ? (
                  <div className="graph-options__pair">
                    <OptionalNumber
                      label={t("graph.options.colorMin")}
                      value={options.colorMin}
                      onChange={(colorMin) => set({ colorMin })}
                    />
                    <OptionalNumber
                      label={t("graph.options.colorMax")}
                      value={options.colorMax}
                      onChange={(colorMax) => set({ colorMax })}
                    />
                  </div>
                ) : null}
              </>
            )}
          </>
        ) : null}
        <ChoiceOption
          label={t("graph.options.sizeBy")}
          value={sizeMode}
          choices={["degree", "property", "same"] as const}
          text={(mode) => t(`graph.options.sizeBy.${mode}`)}
          onChange={(mode) =>
            set({ sizeBy: mode === "degree" ? "degree" : mode === "same" ? "" : "size" })
          }
        />
        {sizeMode === "property" ? (
          <TextOption
            label={t("graph.options.sizeProperty")}
            value={options.sizeBy}
            required
            onChange={(sizeBy) => set({ sizeBy })}
          />
        ) : null}
        <div className="graph-options__pair">
          <NumberOption
            label={t("graph.options.sizeMin")}
            hint={t("graph.options.sizeHint", {
              min: number.format(MIN_SIZE),
              max: number.format(MAX_SIZE),
            })}
            value={options.sizeMin}
            max={MAX_SIZE}
            onChange={(sizeMin) => set({ sizeMin: Math.max(MIN_SIZE, sizeMin) })}
          />
          <NumberOption
            label={t("graph.options.sizeMax")}
            hint={t("graph.options.sizeMaxHint")}
            value={options.sizeMax}
            max={MAX_SIZE}
            onChange={(sizeMax) => set({ sizeMax: Math.max(MIN_SIZE, sizeMax) })}
          />
        </div>
      </Group>
      <Group title={t("graph.options.group.edges")}>
        <TextOption
          label={t("graph.options.edgeWidthBy")}
          hint={t("graph.options.edgeWidthByHint")}
          value={options.edgeWidthBy}
          onChange={(edgeWidthBy) => set({ edgeWidthBy })}
        />
        <ChoiceOption
          label={t("graph.options.arrows")}
          value={options.arrows}
          choices={SHOW_WHEN}
          text={(when) => t(`graph.options.when.${when}`)}
          onChange={(arrows) => set({ arrows })}
        />
        <ChoiceOption
          label={t("graph.options.edgeLabels")}
          value={options.edgeLabels}
          choices={SHOW_WHEN}
          text={(when) => t(`graph.options.when.${when}`)}
          onChange={(edgeLabels) => set({ edgeLabels })}
        />
      </Group>
      <Group title={t("graph.options.group.labels")}>
        <ChoiceOption
          label={t("graph.options.labels")}
          value={options.labels}
          choices={LABEL_MODES}
          text={(mode) => t(`graph.options.labels.${mode}`)}
          onChange={(labels) => set({ labels })}
        />
        {options.labels === "zoom" ? (
          <NumberOption
            label={t("graph.options.labelTop")}
            hint={t("graph.options.labelTopHint", { max: number.format(MAX_LABEL_TOP) })}
            value={options.labelTop}
            min={0}
            max={MAX_LABEL_TOP}
            onChange={(labelTop) => set({ labelTop })}
          />
        ) : null}
      </Group>
      <Group title={t("graph.options.group.click")}>
        <ChoiceOption
          label={t("graph.options.clickAction")}
          hint={t("graph.options.clickActionHint")}
          value={options.clickAction}
          choices={CLICK_ACTIONS}
          text={(action) => t(`graph.options.clickAction.${action}`)}
          onChange={(clickAction) => set({ clickAction })}
        />
        <VariableOptions
          id={variableId}
          names={variables}
          options={options}
          onChange={(patch) => set(patch)}
        />
        {options.clickAction === "details" ? null : (
          <label className="checkbox" htmlFor={detailsId}>
            <input
              id={detailsId}
              type="checkbox"
              checked={options.clickDetails}
              onChange={(event) => set({ clickDetails: event.currentTarget.checked })}
            />
            {t("graph.options.clickDetails")}
          </label>
        )}
      </Group>
      <Group title={t("graph.options.group.explorer")}>
        <label className="checkbox" htmlFor={explorerId}>
          <input
            id={explorerId}
            type="checkbox"
            checked={options.explorer}
            onChange={(event) => set({ explorer: event.currentTarget.checked })}
          />
          {t("graph.options.explorer")}
        </label>
        <NumberOption
          label={t("graph.options.expandLimit")}
          hint={t("graph.options.expandLimitHint", { max: number.format(MAX_EXPAND_LIMIT) })}
          value={options.expandLimit}
          max={MAX_EXPAND_LIMIT}
          onChange={(expandLimit) => set({ expandLimit })}
        />
      </Group>
      <Group title={t("graph.options.group.limits")}>
        <NumberOption
          label={t("graph.options.nodeLimit")}
          hint={t("graph.options.nodeLimitHint", { max: number.format(MAX_NODE_LIMIT) })}
          value={options.nodeLimit}
          max={MAX_NODE_LIMIT}
          onChange={(nodeLimit) => set({ nodeLimit })}
        />
        {network ? (
          <ChoiceOption
            label={t("graph.options.cluster")}
            value={options.cluster}
            choices={CLUSTER_MODES}
            text={(mode) => t(`graph.options.cluster.${mode}`)}
            onChange={(cluster) => set({ cluster })}
          />
        ) : null}
      </Group>
      <Group title={t("graph.options.group.time")}>
        <TextOption
          label={t("graph.options.timeProperty")}
          hint={t("graph.options.timePropertyHint")}
          value={options.timeProperty}
          onChange={(timeProperty) => set({ timeProperty })}
        />
      </Group>
    </>
  );
}

/** A palette color per label; "automatic" keeps the palette's order. */
function LabelColors({
  labels,
  colors,
  onChange,
}: {
  labels: readonly { label: string; count: number }[];
  colors: GraphPanelOptions["labelColors"];
  onChange: (colors: GraphPanelOptions["labelColors"]) => void;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const baseId = useId();
  return (
    <fieldset className="graph-options__labels">
      <legend className="field__label">{t("graph.options.labelColors")}</legend>
      <p className="field__hint">{t("graph.options.labelColorsHint")}</p>
      {labels.map(({ label, count }, i) => {
        const id = `${baseId}-${i}`;
        return (
          <div key={label} className="graph-options__label-row">
            <label htmlFor={id} className="graph-options__label-name">
              {label}
              {count > 0 ? (
                <span className="graph-options__label-count"> {number.format(count)}</span>
              ) : null}
            </label>
            <select
              id={id}
              className="select"
              value={colors[label] ?? ""}
              onChange={(event) => {
                const tone = LABEL_TONES.find((x) => x === event.currentTarget.value);
                const next = { ...colors };
                if (tone === undefined) delete next[label];
                else next[label] = tone;
                onChange(next);
              }}
            >
              <option value="">{t("graph.options.labelColorAuto")}</option>
              {LABEL_TONES.map((tone, n) => (
                <option key={tone} value={tone}>
                  {t("graph.options.labelColor", { number: number.format(n + 1) })}
                </option>
              ))}
            </select>
          </div>
        );
      })}
    </fieldset>
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
