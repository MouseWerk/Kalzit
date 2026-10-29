/**
 * The options a panel plugin declares (`[[panel.options]]` in its manifest) and the checks of
 * option values, exactly as `kalzit_plugin_api::panel::check_options` makes them. Both run the
 * cases of `plugin-api/panel/v1/options.fixture.json`.
 */

export const PANEL_OPTION_TYPES = [
  "string",
  "text",
  "number",
  "integer",
  "bool",
  "select",
] as const;
export type PanelOptionType = (typeof PANEL_OPTION_TYPES)[number];

export const MAX_OPTION_STRING_CHARS = 1024;
export const MAX_OPTION_TEXT_CHARS = 4096;

export interface PanelOption {
  name: string;
  /** By language: `en`, optionally `de`. */
  label: Record<string, string>;
  type: PanelOptionType;
  default?: string | number | boolean;
  choices?: string[];
  min?: number;
  max?: number;
  help?: Record<string, string>;
}

export type OptionRefusal = {
  code: "panel.option_unknown" | "panel.option_invalid";
  message: string;
};

const CONTROL = /\p{Cc}/u;
const CONTROL_BUT_BREAKS = /[^\P{Cc}\n\t]/u;

function chars(text: string): number {
  return [...text].length;
}

function inRange(option: PanelOption, n: number): boolean {
  return (
    (option.min === undefined || n >= option.min) && (option.max === undefined || n <= option.max)
  );
}

function range(option: PanelOption): string {
  if (option.min !== undefined && option.max !== undefined) {
    return ` from ${option.min} to ${option.max}`;
  }
  if (option.min !== undefined) {
    return ` of at least ${option.min}`;
  }
  return option.max === undefined ? "" : ` of at most ${option.max}`;
}

/** Why `value` does not fit `option`, or null when it does. */
export function checkOption(option: PanelOption, value: unknown): OptionRefusal | null {
  const invalid = (what: string): OptionRefusal => ({
    code: "panel.option_invalid",
    message: `options.${option.name}: ${what}`,
  });
  switch (option.type) {
    case "string":
      return typeof value === "string" &&
        chars(value) <= MAX_OPTION_STRING_CHARS &&
        !CONTROL.test(value)
        ? null
        : invalid(`a text of at most ${MAX_OPTION_STRING_CHARS} characters`);
    case "text":
      return typeof value === "string" &&
        chars(value) <= MAX_OPTION_TEXT_CHARS &&
        !CONTROL_BUT_BREAKS.test(value)
        ? null
        : invalid(`a text of at most ${MAX_OPTION_TEXT_CHARS} characters`);
    case "number":
      return typeof value === "number" && Number.isFinite(value) && inRange(option, value)
        ? null
        : invalid(`a number${range(option)}`);
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value) && inRange(option, value)
        ? null
        : invalid(`a whole number${range(option)}`);
    case "bool":
      return typeof value === "boolean" ? null : invalid("a value of type bool");
    case "select":
      return typeof value === "string" && (option.choices ?? []).includes(value)
        ? null
        : invalid(`one of ${(option.choices ?? []).join(", ")}`);
    default:
      return invalid(`a value of type ${String(option.type)}`);
  }
}

/** Why `options` do not fit the declared options, or null: only declared keys, each fitting. */
export function checkOptions(
  declared: readonly PanelOption[],
  options: Record<string, unknown>,
): OptionRefusal | null {
  for (const [key, value] of Object.entries(options)) {
    const option = declared.find((o) => o.name === key);
    if (option === undefined) {
      return {
        code: "panel.option_unknown",
        message: `options.${key} is not an option of this panel`,
      };
    }
    const refused = checkOption(option, value);
    if (refused !== null) {
      return refused;
    }
  }
  return null;
}

/**
 * The options a panel works with: every stored value that fits its option, and the default of
 * each option without one. What does not fit (stored by hand, or by an older version of the
 * plugin) is left out, so the frame receives only values its manifest allows.
 */
export function effectiveOptions(
  declared: readonly PanelOption[],
  stored: unknown,
): Record<string, unknown> {
  const given =
    typeof stored === "object" && stored !== null && !Array.isArray(stored) ? stored : {};
  const out: Record<string, unknown> = {};
  for (const option of declared) {
    const value = (given as Record<string, unknown>)[option.name];
    if (value !== undefined && checkOption(option, value) === null) {
      out[option.name] = value;
    } else if (option.default !== undefined) {
      out[option.name] = option.default;
    }
  }
  return out;
}

/** The text of a manifest label in `language`, English when it has none. */
export function labelIn(label: Record<string, string> | undefined, language: string): string {
  return label?.[language] ?? label?.en ?? "";
}

function isLabel(value: unknown): value is Record<string, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).en === "string" &&
    Object.values(value).every((v) => typeof v === "string")
  );
}

/** One declared option as the server sends it, or null when it is not one this UI knows. */
export function parsePanelOption(raw: unknown): PanelOption | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const r = raw as Record<string, unknown>;
  const type = PANEL_OPTION_TYPES.find((t) => t === r.type);
  if (typeof r.name !== "string" || type === undefined || !isLabel(r.label)) {
    return null;
  }
  const option: PanelOption = { name: r.name, label: r.label, type };
  if (
    typeof r.default === "string" ||
    typeof r.default === "number" ||
    typeof r.default === "boolean"
  ) {
    option.default = r.default;
  }
  if (Array.isArray(r.choices) && r.choices.every((c) => typeof c === "string")) {
    option.choices = r.choices as string[];
  }
  if (typeof r.min === "number") {
    option.min = r.min;
  }
  if (typeof r.max === "number") {
    option.max = r.max;
  }
  if (isLabel(r.help)) {
    option.help = r.help;
  }
  return option;
}
