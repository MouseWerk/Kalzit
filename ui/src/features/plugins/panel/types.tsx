import { useQuery } from "@tanstack/react-query";
import { useEffect, useId } from "react";
import { useI18n } from "../../../i18n/i18n";
import { setExternalPanels } from "../../../panels/registry";
import { CheckboxField, NumberField, SelectField, TextField } from "../../../panels/shared";
import type { AnyPanelPlugin, PanelEditorProps, PanelProps } from "../../../panels/types";
import { type PanelPluginInfo, panelPluginsQuery } from "./api";
import {
  effectiveOptions,
  labelIn,
  MAX_OPTION_STRING_CHARS,
  MAX_OPTION_TEXT_CHARS,
  type PanelOption,
} from "./options";
import { PluginFrame } from "./PluginFrame";
import "./panelPlugins.css";

type Options = Record<string, unknown>;

/**
 * The options editor of a panel plugin, made from the options its manifest declares: one field
 * per option, of its type, with its label and help in the user's language. Values that do not
 * fit are never written: numbers outside their range are not taken, texts are cut at their
 * length.
 */
export function PluginOptionsEditor({
  info,
  options,
  onChange,
}: PanelEditorProps<Options> & { info: PanelPluginInfo }) {
  const { t, language } = useI18n();
  const idBase = useId();
  if (info.options.length === 0) {
    return <p className="field__hint">{t("panelPlugins.options.none")}</p>;
  }
  const set = (name: string, value: unknown) => {
    const next = { ...options };
    if (value === undefined) {
      delete next[name];
    } else {
      next[name] = value;
    }
    onChange(next);
  };
  return (
    <div className="plugin-options">
      {info.options.map((option) => (
        <OptionField
          key={option.name}
          id={`${idBase}-${option.name}`}
          option={option}
          value={options[option.name]}
          label={labelIn(option.label, language)}
          hint={option.help === undefined ? undefined : labelIn(option.help, language)}
          onChange={(value) => set(option.name, value)}
          noneLabel={t("panelPlugins.options.unset")}
        />
      ))}
    </div>
  );
}

function OptionField({
  id,
  option,
  value,
  label,
  hint,
  onChange,
  noneLabel,
}: {
  id: string;
  option: PanelOption;
  value: unknown;
  label: string;
  hint: string | undefined;
  onChange: (value: unknown) => void;
  noneLabel: string;
}) {
  const hintProps = hint === undefined ? {} : { hint };
  switch (option.type) {
    case "bool":
      return (
        <CheckboxField label={label} checked={value === true} onChange={onChange} {...hintProps} />
      );
    case "number":
    case "integer":
      return (
        <NumberField
          label={label}
          value={typeof value === "number" ? value : undefined}
          {...(option.min === undefined ? {} : { min: option.min })}
          {...(option.max === undefined ? {} : { max: option.max })}
          step={option.type === "integer" ? 1 : "any"}
          onChange={(n) =>
            onChange(
              n === undefined || option.type === "number" || Number.isInteger(n) ? n : undefined,
            )
          }
          {...hintProps}
        />
      );
    case "select": {
      const choices = option.choices ?? [];
      const current = typeof value === "string" && choices.includes(value) ? value : "";
      return (
        <SelectField
          id={id}
          label={label}
          value={current}
          choices={[
            ...(option.default === undefined ? [["", noneLabel] as const] : []),
            ...choices.map((c) => [c, c] as const),
          ]}
          onChange={(choice) => onChange(choice === "" ? undefined : choice)}
          {...hintProps}
        />
      );
    }
    case "text":
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
          <textarea
            id={id}
            className="input plugin-options__text"
            value={typeof value === "string" ? value : ""}
            maxLength={MAX_OPTION_TEXT_CHARS}
            aria-describedby={hint === undefined ? undefined : `${id}-hint`}
            onChange={(event) => {
              const text = event.currentTarget.value.replace(/[^\P{Cc}\n\t]/gu, "");
              onChange(text === "" ? undefined : text);
            }}
          />
        </div>
      );
    default:
      return (
        <TextField
          label={label}
          value={typeof value === "string" ? value : ""}
          maxLength={MAX_OPTION_STRING_CHARS}
          onChange={(text) => {
            const clean = text.replace(/\p{Cc}/gu, "");
            onChange(clean === "" ? undefined : clean);
          }}
          {...hintProps}
        />
      );
  }
}

/** The panel type of a panel plugin, for the registry. */
export function pluginPanelType(info: PanelPluginInfo): AnyPanelPlugin {
  // biome-ignore lint/correctness/noComponentHookFactories: one panel type per plugin version, made once and kept (`typeOf`)
  function PluginPanel(props: PanelProps<Options>) {
    return (
      <PluginFrame
        info={info}
        options={props.options}
        series={props.series ?? []}
        timeRange={props.timeRange}
        title={props.title}
      />
    );
  }
  // biome-ignore lint/correctness/noComponentHookFactories: as above, one editor per plugin version
  function PluginEditor(props: PanelEditorProps<Options>) {
    return <PluginOptionsEditor info={info} {...props} />;
  }
  return {
    type: info.id,
    name: "panelPlugins.panel",
    label: info.name,
    ...(info.description === undefined ? {} : { hint: info.description }),
    ...(info.publisher === undefined ? {} : { badge: info.publisher }),
    external: true,
    shapes: info.shapes,
    options: (stored: unknown) => effectiveOptions(info.options, stored),
    Panel: PluginPanel,
    Editor: PluginEditor,
  };
}

// The same type object for the same plugin version, so panels keep their parsed options.
const types = new Map<string, AnyPanelPlugin>();

function typeOf(info: PanelPluginInfo): AnyPanelPlugin {
  const key = JSON.stringify(info);
  let type = types.get(key);
  if (type === undefined) {
    type = pluginPanelType(info);
    types.set(key, type);
  }
  return type;
}

/**
 * Loads the panel types of the organization's panel plugins into the registry, so dashboards
 * draw them and the panel editor offers them. Without the list (an error, or while it loads)
 * a plugin's panel shows that its plugin is not available.
 */
export function usePanelPluginTypes(orgId: string): void {
  const list = useQuery(panelPluginsQuery(orgId));
  const data = list.data;
  useEffect(() => {
    if (data !== undefined) {
      setExternalPanels(data.map(typeOf));
    }
  }, [data]);
}
