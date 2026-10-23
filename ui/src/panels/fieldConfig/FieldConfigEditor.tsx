import { type ReactNode, useId } from "react";
import { type MessageKey, type MessageParams, useI18n } from "../../i18n/i18n";
import { NumberField, SelectField, TextField } from "../shared";
import type { FieldOptionGroup } from "../types";
import {
  CELL_DISPLAYS,
  DEFAULT_THRESHOLDS,
  type FieldConfig,
  type FieldOptions,
  type FieldOverride,
  LIMITS,
  OPTION_KEYS,
  type OverrideProperties,
  parseFieldConfig,
  type Thresholds,
  TONES,
  type Tone,
  type ValueMapping,
} from "./fieldConfig";
import { patternStatus, usePatternEngine } from "./pattern";
import { CUSTOM_PREFIX, UNIT_GROUPS, UNITS } from "./units";
import "../viz.css";

type Translate = (key: MessageKey, params?: MessageParams) => string;

export function toneLabel(t: Translate, tone: Tone): string {
  if (tone.startsWith("chart-")) {
    return t("panels.tone.chart", { number: tone.slice("chart-".length) });
  }
  return t(`panels.tone.${tone as "ok" | "warn" | "critical" | "neutral"}`);
}

/*
 * What the editor adds when asked for a new entry. The contract test sends these, with every
 * panel's default options, through the server's checks (panel_options_fixture.json).
 */
export function newStep(last: number): Thresholds["steps"][number] {
  return { value: last + 10, tone: "warn" };
}

export function newMapping(type: ValueMapping["type"]): ValueMapping {
  return type === "value"
    ? { type, value: "" }
    : type === "range"
      ? { type, from: null, to: null }
      : { type, pattern: "" };
}

export function newOverride(): FieldOverride {
  return { matcher: { type: "name", value: "" }, properties: {} };
}

/** A copy of the options without one key, for clearing a setting. */
function without<K extends keyof FieldOptions>(options: FieldOptions, key: K): FieldOptions {
  const next = { ...options };
  delete next[key];
  return next;
}

function set<K extends keyof FieldOptions>(
  options: FieldOptions,
  key: K,
  value: FieldOptions[K] | undefined,
): FieldOptions {
  return value === undefined || value === "" ? without(options, key) : { ...options, [key]: value };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <details className="viz-editor__section">
      <summary className="viz-editor__summary">{title}</summary>
      <div className="viz-editor__body">{children}</div>
    </details>
  );
}

function ToneSelect({
  label,
  value,
  onChange,
  optional,
}: {
  label: string;
  value: Tone | undefined;
  onChange: (tone: Tone | undefined) => void;
  optional?: boolean;
}) {
  const { t } = useI18n();
  const choices: (readonly [string, string])[] = [
    ...(optional === true ? [["", t("panels.tone.none")] as const] : []),
    ...TONES.map((tone) => [tone, toneLabel(t, tone)] as const),
  ];
  return (
    <SelectField
      label={label}
      value={value ?? ""}
      choices={choices}
      onChange={(next) => onChange(next === "" ? undefined : (next as Tone))}
    />
  );
}

/** The unit picker: catalog units by group, and a custom suffix. */
export function UnitPicker({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (unit: string | undefined) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const custom = value?.startsWith(CUSTOM_PREFIX);
  const currencyNames =
    typeof Intl.DisplayNames === "function"
      ? new Intl.DisplayNames(language, { type: "currency" })
      : null;
  const labelOf = (unitId: string, symbol: string) => {
    if (unitId.startsWith("currency:")) {
      const code = unitId.slice("currency:".length);
      return `${currencyNames?.of(code) ?? code} (${code})`;
    }
    const name = t(`panels.unit.${unitId}` as MessageKey);
    return symbol === "" ? name : `${name} (${symbol})`;
  };
  return (
    <>
      <div className="field">
        <label className="field__label" htmlFor={id}>
          {t("dashboards.panels.unit")}
        </label>
        <select
          id={id}
          className="select"
          value={custom ? "custom" : (value ?? "")}
          onChange={(event) => {
            const next = event.currentTarget.value;
            onChange(next === "" ? undefined : next === "custom" ? CUSTOM_PREFIX : next);
          }}
        >
          <option value="">{t("panels.unit.auto")}</option>
          {UNIT_GROUPS.map((group) => (
            <optgroup key={group} label={t(`panels.unitGroup.${group}`)}>
              {UNITS.filter((u) => u.group === group).map((u) => (
                <option key={u.id} value={u.id}>
                  {labelOf(u.id, u.symbol)}
                </option>
              ))}
            </optgroup>
          ))}
          <option value="custom">{t("panels.unit.custom")}</option>
        </select>
      </div>
      {custom ? (
        <TextField
          label={t("panels.unit.customText")}
          hint={t("dashboards.panels.unitHint")}
          value={(value ?? "").slice(CUSTOM_PREFIX.length)}
          maxLength={LIMITS.unitChars}
          onChange={(text) => onChange(`${CUSTOM_PREFIX}${text}`)}
        />
      ) : null}
    </>
  );
}

function ThresholdsEditor({
  value,
  onChange,
}: {
  value: Thresholds | undefined;
  onChange: (thresholds: Thresholds | undefined) => void;
}) {
  const { t } = useI18n();
  if (value === undefined) {
    return (
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => onChange(DEFAULT_THRESHOLDS)}
      >
        {t("panels.thresholds.add")}
      </button>
    );
  }
  const steps = value.steps;
  // Steps keep their place while edited, so a row does not jump under the cursor; reading the
  // options sorts them by value.
  const update = (index: number, patch: Partial<Thresholds["steps"][number]>) =>
    onChange({
      ...value,
      steps: steps.map((step, i) => (i === index ? { ...step, ...patch } : step)),
    });
  return (
    <>
      <SelectField
        label={t("panels.thresholds.mode")}
        value={value.mode}
        choices={[
          ["absolute", t("panels.thresholds.mode.absolute")],
          ["percentage", t("panels.thresholds.mode.percentage")],
        ]}
        onChange={(mode) => onChange({ ...value, mode })}
      />
      <ol className="viz-editor__list">
        {steps.map((step, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: steps are edited in place
          <li key={`${index}-${steps.length}`} className="viz-editor__row">
            {index === 0 ? (
              <p className="field__hint">{t("panels.thresholds.base")}</p>
            ) : (
              <NumberField
                label={t("panels.thresholds.from")}
                value={step.value ?? undefined}
                onChange={(v) => (v === undefined ? undefined : update(index, { value: v }))}
              />
            )}
            <ToneSelect
              label={t("panels.color")}
              value={step.tone}
              onChange={(tone) => update(index, { tone: tone ?? "neutral" })}
            />
            {index === 0 ? null : (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onChange({ ...value, steps: steps.filter((_, i) => i !== index) })}
              >
                {t("panels.remove")}
              </button>
            )}
          </li>
        ))}
      </ol>
      <div className="toolbar">
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={steps.length >= LIMITS.thresholdSteps}
          onClick={() => {
            const last = steps.at(-1)?.value ?? 0;
            onChange({ ...value, steps: [...steps, newStep(last)] });
          }}
        >
          {t("panels.thresholds.addStep")}
        </button>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => onChange(undefined)}
        >
          {t("panels.thresholds.clear")}
        </button>
      </div>
    </>
  );
}

function MappingEditor({
  mapping,
  onChange,
  onRemove,
}: {
  mapping: ValueMapping;
  onChange: (mapping: ValueMapping) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const status = mapping.type === "regex" ? patternStatus(mapping.pattern) : "valid";
  const invalid = status === "invalid";
  return (
    <li className="viz-editor__row">
      <SelectField
        label={t("panels.mappings.type")}
        value={mapping.type}
        choices={[
          ["value", t("panels.mappings.type.value")],
          ["range", t("panels.mappings.type.range")],
          ["regex", t("panels.mappings.type.regex")],
        ]}
        onChange={(type) => {
          const shown = { text: mapping.text, tone: mapping.tone };
          onChange(JSON.parse(JSON.stringify({ ...newMapping(type), ...shown })) as ValueMapping);
        }}
      />
      {mapping.type === "value" ? (
        <TextField
          label={t("panels.mappings.value")}
          value={mapping.value}
          maxLength={LIMITS.textChars}
          onChange={(value) => onChange({ ...mapping, value })}
        />
      ) : null}
      {mapping.type === "range" ? (
        <>
          <NumberField
            label={t("panels.mappings.from")}
            value={mapping.from ?? undefined}
            onChange={(from) => onChange({ ...mapping, from: from ?? null })}
          />
          <NumberField
            label={t("panels.mappings.to")}
            value={mapping.to ?? undefined}
            onChange={(to) => onChange({ ...mapping, to: to ?? null })}
          />
          {mapping.from !== null && mapping.to !== null && mapping.from > mapping.to ? (
            <p className="field__error" role="alert">
              {t("panels.mappings.rangeInvalid")}
            </p>
          ) : null}
        </>
      ) : null}
      {mapping.type === "regex" ? (
        <>
          <TextField
            label={t("panels.mappings.pattern")}
            value={mapping.pattern}
            maxLength={LIMITS.textChars}
            mono
            onChange={(pattern) => onChange({ ...mapping, pattern })}
          />
          {invalid ? (
            <p className="field__error" role="alert">
              {t("panels.invalidPattern")}
            </p>
          ) : status === "checking" ? (
            <p className="field__hint">{t("panels.checkingPattern")}</p>
          ) : null}
        </>
      ) : null}
      <TextField
        label={t("panels.mappings.text")}
        value={mapping.text ?? ""}
        maxLength={LIMITS.textChars}
        onChange={(text) => {
          const { text: _old, ...rest } = mapping;
          onChange(text === "" ? rest : { ...rest, text });
        }}
      />
      <ToneSelect
        label={t("panels.color")}
        value={mapping.tone}
        optional
        onChange={(tone) => {
          const { tone: _old, ...rest } = mapping;
          onChange(tone === undefined ? rest : { ...rest, tone });
        }}
      />
      <button type="button" className="button button--ghost button--small" onClick={onRemove}>
        {t("panels.remove")}
      </button>
    </li>
  );
}

/** The editors of one set of field options, for the defaults or one override. */
function OptionsFields({
  options,
  groups,
  onChange,
}: {
  options: FieldOptions;
  groups: readonly FieldOptionGroup[];
  onChange: (options: FieldOptions) => void;
}) {
  const { t } = useI18n();
  const mappings = options.mappings ?? [];
  return (
    <>
      {groups.includes("standard") ? (
        <Section title={t("panels.section.standard")}>
          <UnitPicker
            value={options.unit}
            onChange={(unit) => onChange(set(options, "unit", unit))}
          />
          <NumberField
            label={t("panels.decimals")}
            hint={t("panels.decimalsHint")}
            value={options.decimals}
            min={0}
            max={LIMITS.decimals}
            step={1}
            onChange={(decimals) =>
              decimals === undefined || Number.isInteger(decimals)
                ? onChange(set(options, "decimals", decimals))
                : undefined
            }
          />
          <TextField
            label={t("panels.displayName")}
            value={options.displayName ?? ""}
            maxLength={LIMITS.textChars}
            onChange={(displayName) => onChange(set(options, "displayName", displayName))}
          />
          <TextField
            label={t("panels.noValue")}
            hint={t("panels.noValueHint")}
            value={options.noValue ?? ""}
            maxLength={LIMITS.noValueChars}
            onChange={(noValue) => onChange(set(options, "noValue", noValue))}
          />
        </Section>
      ) : null}
      {groups.includes("range") ? (
        <Section title={t("panels.section.range")}>
          <NumberField
            label={t("panels.min")}
            hint={t("panels.rangeHint")}
            value={options.min}
            onChange={(min) => onChange(set(options, "min", min))}
          />
          <NumberField
            label={t("panels.max")}
            value={options.max}
            onChange={(max) => onChange(set(options, "max", max))}
          />
          {options.min !== undefined && options.max !== undefined && options.min >= options.max ? (
            <p className="field__error" role="alert">
              {t("panels.rangeInvalid")}
            </p>
          ) : null}
        </Section>
      ) : null}
      {groups.includes("thresholds") ? (
        <Section title={t("panels.section.thresholds")}>
          <ThresholdsEditor
            value={options.thresholds}
            onChange={(thresholds) => onChange(set(options, "thresholds", thresholds))}
          />
        </Section>
      ) : null}
      {groups.includes("mappings") ? (
        <Section title={t("panels.section.mappings")}>
          <p className="field__hint">{t("panels.mappings.hint")}</p>
          <ol className="viz-editor__list">
            {mappings.map((mapping, index) => (
              <MappingEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: mappings are edited in place
                key={`${index}-${mappings.length}`}
                mapping={mapping}
                onChange={(next) =>
                  onChange({
                    ...options,
                    mappings: mappings.map((m, i) => (i === index ? next : m)),
                  })
                }
                onRemove={() =>
                  onChange(
                    set(
                      options,
                      "mappings",
                      mappings.filter((_, i) => i !== index),
                    ),
                  )
                }
              />
            ))}
          </ol>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={mappings.length >= LIMITS.mappings}
            onClick={() => onChange({ ...options, mappings: [...mappings, newMapping("value")] })}
          >
            {t("panels.mappings.add")}
          </button>
        </Section>
      ) : null}
      {groups.includes("color") ? (
        <Section title={t("panels.section.color")}>
          <ToneSelect
            label={t("panels.fixedColor")}
            value={options.color}
            optional
            onChange={(color) => onChange(set(options, "color", color))}
          />
        </Section>
      ) : null}
      {groups.includes("table") ? (
        <Section title={t("panels.section.table")}>
          <SelectField
            label={t("panels.cellDisplay")}
            value={options.cellDisplay ?? "auto"}
            choices={CELL_DISPLAYS.map((d) => [d, t(`panels.cellDisplay.${d}`)])}
            onChange={(cellDisplay) =>
              onChange(
                set(options, "cellDisplay", cellDisplay === "auto" ? undefined : cellDisplay),
              )
            }
          />
          {options.cellDisplay === "link" ? (
            <TextField
              label={t("panels.link")}
              hint={t("panels.linkHint")}
              value={options.link ?? ""}
              maxLength={LIMITS.linkChars}
              mono
              onChange={(link) => onChange(set(options, "link", link))}
            />
          ) : null}
          <NumberField
            label={t("panels.width")}
            value={options.width}
            min={LIMITS.minWidth}
            max={LIMITS.maxWidth}
            step={1}
            onChange={(width) => onChange(set(options, "width", width))}
          />
        </Section>
      ) : null}
    </>
  );
}

function OverrideEditor({
  override,
  groups,
  onChange,
  onRemove,
}: {
  override: FieldOverride;
  groups: readonly FieldOptionGroup[];
  onChange: (override: FieldOverride) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const status =
    override.matcher.type === "regex" ? patternStatus(override.matcher.value) : "valid";
  const invalid = status === "invalid";
  const present = OPTION_KEYS.filter((key) => override.properties[key] !== undefined);
  const cleared = OPTION_KEYS.filter((key) => override.properties[key] === null);
  return (
    <li className="viz-editor__override">
      <SelectField
        label={t("panels.overrides.matchBy")}
        value={override.matcher.type}
        choices={[
          ["name", t("panels.overrides.byName")],
          ["regex", t("panels.overrides.byRegex")],
        ]}
        onChange={(type) => onChange({ ...override, matcher: { ...override.matcher, type } })}
      />
      <TextField
        label={t("panels.overrides.match")}
        value={override.matcher.value}
        maxLength={LIMITS.textChars}
        mono
        onChange={(value) => onChange({ ...override, matcher: { ...override.matcher, value } })}
      />
      {invalid ? (
        <p className="field__error" role="alert">
          {t("panels.invalidPattern")}
        </p>
      ) : status === "checking" ? (
        <p className="field__hint">{t("panels.checkingPattern")}</p>
      ) : null}
      <OptionsFields
        options={setOptions(override.properties)}
        groups={groups.filter((g) => g !== "overrides")}
        onChange={(next) => {
          // Cleared properties stay cleared unless the editor set them again.
          const properties: OverrideProperties = { ...next };
          for (const key of cleared) {
            if (properties[key] === undefined) properties[key] = null;
          }
          onChange({ ...override, properties });
        }}
      />
      {present.length === 0 ? null : (
        <ul className="viz-editor__chips" aria-label={t("panels.overrides.setHere")}>
          {present.map((key) => (
            <li key={key} className="viz-editor__chip">
              <span>
                {t(`panels.option.${key}`)}
                {override.properties[key] === null ? ` (${t("panels.overrides.cleared")})` : ""}
              </span>
              <button
                type="button"
                className="button button--ghost button--small"
                aria-label={t("panels.overrides.resetNamed", { option: t(`panels.option.${key}`) })}
                onClick={() => {
                  const properties = { ...override.properties };
                  delete properties[key];
                  onChange({ ...override, properties });
                }}
              >
                {t("panels.overrides.reset")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <SelectField
        label={t("panels.overrides.clear")}
        hint={t("panels.overrides.clearHint")}
        value=""
        choices={[
          ["", "–"],
          ...OPTION_KEYS.filter((key) => !present.includes(key)).map(
            (key) => [key, t(`panels.option.${key}`)] as const,
          ),
        ]}
        onChange={(key) => {
          if (key !== "") {
            onChange({ ...override, properties: { ...override.properties, [key]: null } });
          }
        }}
      />
      <button type="button" className="button button--ghost button--small" onClick={onRemove}>
        {t("panels.overrides.remove")}
      </button>
    </li>
  );
}

/** The properties an override sets to a value, for the option editors. */
function setOptions(properties: OverrideProperties): FieldOptions {
  const options: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (value !== null && value !== undefined) options[key] = value;
  }
  return options as FieldOptions;
}

/**
 * The shared field options of a panel: the groups the panel uses for every field, then
 * overrides for fields picked by name or pattern. Later overrides win over earlier ones.
 */
export function FieldConfigEditor({
  value,
  groups,
  onChange,
}: {
  value: unknown;
  groups: readonly FieldOptionGroup[];
  onChange: (config: FieldConfig) => void;
}) {
  const { t } = useI18n();
  // The editor checks patterns as they are typed, so it loads re2js right away, and draws its
  // pattern messages again once re2js is there.
  const ready = usePatternEngine(true);
  const config = parseFieldConfig(value);
  const overrides = config.overrides;
  return (
    <div className="viz-editor" key={ready ? "checked" : "checking"}>
      <OptionsFields
        options={config.defaults}
        groups={groups}
        onChange={(defaults) => onChange({ ...config, defaults })}
      />
      {groups.includes("overrides") ? (
        <Section title={t("panels.section.overrides")}>
          <p className="field__hint">{t("panels.overrides.hint")}</p>
          <ol className="viz-editor__list">
            {overrides.map((override, index) => (
              <OverrideEditor
                // biome-ignore lint/suspicious/noArrayIndexKey: overrides are edited in place
                key={`${index}-${overrides.length}`}
                override={override}
                groups={groups}
                onChange={(next) =>
                  onChange({
                    ...config,
                    overrides: overrides.map((o, i) => (i === index ? next : o)),
                  })
                }
                onRemove={() =>
                  onChange({ ...config, overrides: overrides.filter((_, i) => i !== index) })
                }
              />
            ))}
          </ol>
          <button
            type="button"
            className="button button--secondary button--small"
            disabled={overrides.length >= LIMITS.overrides}
            onClick={() =>
              onChange({
                ...config,
                overrides: [...overrides, newOverride()],
              })
            }
          >
            {t("panels.overrides.add")}
          </button>
        </Section>
      ) : null}
    </div>
  );
}
