import type {
  ErrorBody,
  QueryOutcome,
  VariableOption,
  VariableOptionsResponse,
} from "../../../api/generated/shapes";
import { VARIABLE_SORTS } from "../../dashboards/model";

/**
 * A table's first field as values and its second as labels, distinct by value. The fake reads
 * only tables; other shapes give no options here. (Importing the UI's reader here would load the
 * dashboards' modules into every test that starts the fake server.)
 */
function frameOptions(outcome: QueryOutcome): { options: VariableOption[]; truncated: boolean } {
  if (!("result" in outcome) || outcome.result.shape !== "frame") {
    return { options: [], truncated: false };
  }
  const [values, labels] = outcome.result.frame.fields;
  const seen = new Set<string>();
  const options: VariableOption[] = [];
  (values?.values ?? []).forEach((raw, row) => {
    if (raw === null || raw === undefined || seen.has(String(raw))) return;
    seen.add(String(raw));
    const label = labels?.values[row];
    options.push({
      value: String(raw),
      label: label === null || label === undefined ? String(raw) : String(label),
    });
  });
  return { options, truncated: outcome.result.frame.meta?.rowsTruncated === true };
}

/**
 * The fake server's reading of a variable's query result, as the server documents it
 * (docs/api/datasources.md, "Variable options"): options from the result's shape, then the regex
 * (`/pattern/flags`, named groups `text` and `value`, or one unnamed group), the order and the
 * fixed extra values. The fake uses the browser's regex engine; the server's refuses lookaround
 * and backreferences, which the tests do not use.
 */
export function refineFakeOptions(
  outcome: QueryOutcome,
  variable: Record<string, unknown>,
): VariableOptionsResponse | { error: ErrorBody } {
  const read = frameOptions(outcome);
  let options: VariableOption[] = read.options;
  let unmatched = 0;
  if (typeof variable.regex === "string" && variable.regex !== "") {
    const raw = variable.regex;
    const slashed = /^\/(.*)\/([a-z]*)$/s.exec(raw);
    let regex: RegExp;
    try {
      regex = new RegExp(slashed?.[1] ?? raw, (slashed?.[2] ?? "").replace("g", ""));
    } catch {
      const detail = "not a valid regular expression";
      return {
        error: {
          code: "validation",
          message: detail,
          field: "regex",
          reason: "variables.regex_invalid",
          params: { detail },
        },
      };
    }
    const seen = new Set<string>();
    const kept: VariableOption[] = [];
    for (const option of options) {
      const match = regex.exec(option.value);
      if (match === null) {
        unmatched += 1;
        continue;
      }
      const groups = match.groups ?? {};
      let next: VariableOption;
      if (groups.text !== undefined || groups.value !== undefined) {
        const value = groups.value ?? option.value;
        next = { value, label: groups.text ?? (groups.value !== undefined ? value : option.label) };
      } else if (match[1] !== undefined) {
        next = { value: match[1], label: match[1] };
      } else {
        next = option;
      }
      if (!seen.has(next.value)) {
        seen.add(next.value);
        kept.push(next);
      }
    }
    options = kept;
  }
  const sort = VARIABLE_SORTS.find((s) => s === variable.sort);
  if (sort !== undefined) {
    const num = (o: VariableOption) => (o.value.trim() === "" ? Number.NaN : Number(o.value));
    const compare: Record<typeof sort, (a: VariableOption, b: VariableOption) => number> = {
      alphabetical: (a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0),
      alphabeticalDesc: (a, b) => (a.label > b.label ? -1 : a.label < b.label ? 1 : 0),
      caseInsensitive: (a, b) => a.label.toLowerCase().localeCompare(b.label.toLowerCase()),
      caseInsensitiveDesc: (a, b) => b.label.toLowerCase().localeCompare(a.label.toLowerCase()),
      numerical: (a, b) => (num(a) || 0) - (num(b) || 0),
      numericalDesc: (a, b) => (num(b) || 0) - (num(a) || 0),
    };
    options = [...options].sort(compare[sort]);
  }
  for (const extra of (variable.staticOptions ?? []) as { value: string; label?: string }[]) {
    if (!options.some((o) => o.value === extra.value)) {
      options.push({ value: extra.value, label: extra.label ?? extra.value });
    }
  }
  return {
    options,
    truncated: read.truncated,
    ...(unmatched > 0 ? { unmatched } : {}),
  };
}
