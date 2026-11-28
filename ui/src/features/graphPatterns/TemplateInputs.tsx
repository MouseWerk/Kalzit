import "../analyses/analyses.css";
import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ParameterType, Pattern, PatternParameter } from "../../api/generated/shapes";
import { Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { useSettled } from "../../lib/useSettled";
import { compilePattern, fetchChoices, graphSchemaQuery } from "./api";
import { PasteValuesDialog } from "./PasteValuesDialog";
import { PatternList } from "./PatternBuilder";
import { isListType, readList, typedSample } from "./pattern";
import { patternSentence, TYPE_TEXT } from "./sentence";
import "./patterns.css";

/*
 * Search templates (board Graph083, frames 11 to 13): a saved analysis with named inputs that
 * people who may read it fill in and run, viewers too. The text of the query is fixed; the inputs
 * are typed parameters (docs/api/analyses.md, "parameters").
 */

/** How a person gives a value (frame 11, "Eingabe je Variable"). */
type InputKind = "free" | "choices";

const SINGLE: ParameterType[] = ["string", "integer", "float", "boolean"];

/**
 * "Was Personen eingeben" in the save dialog: a label per input, and for text and numbers a choice
 * from the values of one property instead of a free field. A template from typed text may also
 * set each input's type; a pattern's types come from its conditions.
 */
export function TemplateInputsEditor({
  orgId,
  datasourceId,
  parameters,
  typesEditable,
  refId,
  onChange,
}: {
  orgId: string;
  datasourceId: string;
  parameters: PatternParameter[];
  /** A template from text: the types are not known from a pattern. */
  typesEditable: boolean;
  /** The target the choices read from, for a template from text. */
  refId: string;
  onChange: (parameters: PatternParameter[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const schema = useQuery({ ...graphSchemaQuery(orgId, datasourceId), retry: false });
  // `undefined` or "" in the patch leaves that field out.
  const set = (
    name: string,
    patch: { [K in keyof PatternParameter]?: PatternParameter[K] | undefined },
  ) =>
    onChange(
      parameters.map((p) => {
        if (p.name !== name) return p;
        const next = { ...p, ...patch } as Record<string, unknown>;
        for (const key of ["label", "choices"]) {
          if (next[key] === undefined || next[key] === "") delete next[key];
        }
        return next as unknown as PatternParameter;
      }),
    );
  return (
    <section className="analysis-save__summary" aria-labelledby={`${id}-title`}>
      <h3 className="analysis-save__caption" id={`${id}-title`}>
        {t("graphPatterns.template.inputs")}
      </h3>
      <table className="pattern-table">
        <thead>
          <tr>
            <th scope="col">{t("graphPatterns.parameters.variable")}</th>
            <th scope="col">{t("graphPatterns.template.label")}</th>
            <th scope="col">{t("graphPatterns.template.input")}</th>
          </tr>
        </thead>
        <tbody>
          {parameters.map((p) => {
            const kind: InputKind = p.choices === undefined ? "free" : "choices";
            const canChoose = p.type === "string" || p.type === "integer" || p.type === "float";
            const labels = schema.data?.labels ?? [];
            const label = labels.find((l) => l.name === p.choices?.label);
            return (
              <tr key={p.name}>
                <th scope="row">
                  <code>${p.name}</code>
                </th>
                <td>
                  <input
                    className="input"
                    aria-label={t("graphPatterns.template.labelOf", { name: p.name })}
                    value={p.label ?? ""}
                    placeholder={p.name}
                    maxLength={100}
                    onChange={(event) => set(p.name, { label: event.currentTarget.value })}
                  />
                </td>
                <td>
                  <div className="pattern-template__input">
                    {typesEditable ? (
                      <Select
                        aria-label={t("graphPatterns.parameters.typeOf", { name: p.name })}
                        value={p.type}
                        onChange={(type) => {
                          const next = type as ParameterType;
                          set(p.name, {
                            type: next,
                            ...(next === "boolean" || isListType(next)
                              ? { choices: undefined }
                              : {}),
                          });
                        }}
                      >
                        {[...SINGLE, "stringList", "integerList", "floatList"].map((type) => (
                          <option key={type} value={type}>
                            {t(TYPE_TEXT[type as ParameterType])}
                          </option>
                        ))}
                      </Select>
                    ) : null}
                    {canChoose ? (
                      <Select
                        aria-label={t("graphPatterns.template.inputOf", { name: p.name })}
                        value={kind}
                        onChange={(next) =>
                          set(
                            p.name,
                            next === "free"
                              ? { choices: undefined }
                              : {
                                  choices: {
                                    label: labels[0]?.name ?? "",
                                    property: labels[0]?.properties[0]?.name ?? "",
                                    ...(typesEditable ? { refId } : {}),
                                  },
                                },
                          )
                        }
                      >
                        <option value="free">{t("graphPatterns.template.free")}</option>
                        <option value="choices" disabled={labels.length === 0}>
                          {t("graphPatterns.template.choices")}
                        </option>
                      </Select>
                    ) : (
                      <span>
                        {t(
                          p.type === "boolean"
                            ? "graphPatterns.template.switch"
                            : "graphPatterns.template.list",
                        )}
                      </span>
                    )}
                    {p.choices === undefined ? null : (
                      <>
                        <Select
                          aria-label={t("graphPatterns.template.choicesLabel", { name: p.name })}
                          value={p.choices.label}
                          onChange={(next) => {
                            const chosen = labels.find((l) => l.name === next);
                            set(p.name, {
                              choices: {
                                ...p.choices,
                                label: next,
                                property: chosen?.properties[0]?.name ?? "",
                              },
                            });
                          }}
                        >
                          {labels.map((l) => (
                            <option key={l.name} value={l.name}>
                              {l.name}
                            </option>
                          ))}
                        </Select>
                        <Select
                          aria-label={t("graphPatterns.template.choicesProperty", { name: p.name })}
                          value={p.choices.property}
                          onChange={(next) =>
                            p.choices === undefined
                              ? undefined
                              : set(p.name, { choices: { ...p.choices, property: next } })
                          }
                        >
                          {(label?.properties ?? []).map((prop) => (
                            <option key={prop.name} value={prop.name}>
                              {prop.name}
                            </option>
                          ))}
                        </Select>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="field__hint">{t("graphPatterns.template.who")}</p>
      <p className="field__hint">{t("graphPatterns.template.what")}</p>
    </section>
  );
}

/** The values a person gave, typed; `missing` and `wrong` name the inputs that hold the run. */
export function readInputs(
  parameters: readonly PatternParameter[],
  values: Readonly<Record<string, unknown>>,
): { variables: Record<string, unknown>; missing: string[]; wrong: string[] } {
  const variables: Record<string, unknown> = {};
  const missing: string[] = [];
  const wrong: string[] = [];
  for (const p of parameters) {
    const raw = values[p.name];
    if (p.type === "boolean") {
      variables[p.name] = raw === true;
      continue;
    }
    if (raw === undefined || raw === "" || (Array.isArray(raw) && raw.length === 0)) {
      missing.push(p.name);
      continue;
    }
    const typed = typedSample(p.type, raw);
    if (typed === undefined) {
      wrong.push(p.name);
    } else {
      variables[p.name] = typed;
    }
  }
  return { variables, missing, wrong };
}

/**
 * The inputs of a template on its page (frame 12): one field per input, a choice from values
 * where the template offers them, a list where it takes one; "Ausführen" runs the stored query
 * with these values only.
 */
export function TemplateRunInputs({
  orgId,
  analysisId,
  parameters,
  values,
  busy,
  ran,
  onValues,
  onRun,
}: {
  orgId: string;
  analysisId: string;
  parameters: PatternParameter[];
  values: Record<string, unknown>;
  busy: boolean;
  /** The search ran with given inputs; before that a hint says what to do. */
  ran: boolean;
  onValues: (values: Record<string, unknown>) => void;
  onRun: (variables: Record<string, unknown>) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [tried, setTried] = useState(false);
  const [paste, setPaste] = useState<PatternParameter | null>(null);
  const read = readInputs(parameters, values);
  const name = (p: PatternParameter) => p.label ?? p.name;
  return (
    <form
      className="pattern-template"
      noValidate
      aria-label={t("graphPatterns.template.inputs")}
      onSubmit={(event) => {
        event.preventDefault();
        setTried(true);
        if (read.missing.length === 0 && read.wrong.length === 0) onRun(read.variables);
      }}
    >
      <div className="pattern-template__fields">
        {parameters.map((p) => {
          const fieldId = `${id}-${p.name}`;
          const isMissing = tried && read.missing.includes(p.name);
          const isWrong = read.wrong.includes(p.name) && (tried || values[p.name] !== undefined);
          const error = isWrong
            ? t("graphPatterns.template.wrong", { name: name(p), type: t(TYPE_TEXT[p.type]) })
            : isMissing
              ? t("graphPatterns.template.missing", { name: name(p) })
              : undefined;
          const raw = values[p.name];
          return (
            <div key={p.name} className="field pattern-template__field">
              {p.type === "boolean" ? (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={raw === true}
                    onChange={(event) =>
                      onValues({ ...values, [p.name]: event.currentTarget.checked })
                    }
                  />
                  {name(p)}
                </label>
              ) : (
                <>
                  <label className="field__label" htmlFor={fieldId}>
                    {name(p)}
                  </label>
                  {isListType(p.type) ? (
                    <>
                      <textarea
                        id={fieldId}
                        className="input input--mono"
                        rows={3}
                        value={typeof raw === "string" ? raw : ""}
                        aria-invalid={error === undefined ? undefined : true}
                        aria-describedby={`${fieldId}-hint`}
                        onChange={(event) =>
                          onValues({ ...values, [p.name]: event.currentTarget.value })
                        }
                      />
                      <button
                        type="button"
                        className="button button--ghost button--small"
                        onClick={() => setPaste(p)}
                      >
                        {t("graphPatterns.condition.paste")}
                      </button>
                    </>
                  ) : p.choices !== undefined ? (
                    <ChoiceField
                      id={fieldId}
                      orgId={orgId}
                      analysisId={analysisId}
                      parameter={p.name}
                      value={typeof raw === "string" ? raw : ""}
                      invalid={error !== undefined}
                      onChange={(text) => onValues({ ...values, [p.name]: text })}
                    />
                  ) : (
                    <input
                      id={fieldId}
                      className="input"
                      inputMode={p.type === "integer" || p.type === "float" ? "decimal" : undefined}
                      value={typeof raw === "string" || typeof raw === "number" ? String(raw) : ""}
                      aria-invalid={error === undefined ? undefined : true}
                      aria-describedby={`${fieldId}-hint`}
                      onChange={(event) =>
                        onValues({ ...values, [p.name]: event.currentTarget.value })
                      }
                    />
                  )}
                </>
              )}
              {error === undefined ? (
                <p className="field__hint" id={`${fieldId}-hint`}>
                  {isListType(p.type)
                    ? t("graphPatterns.template.listHint", {
                        count: readList(typeof raw === "string" ? raw : "", p.type).values.length,
                      })
                    : t(TYPE_TEXT[p.type])}
                </p>
              ) : (
                <p className="field__error" id={`${fieldId}-hint`}>
                  {error}
                </p>
              )}
            </div>
          );
        })}
        <button
          type="submit"
          className="button button--primary pattern-template__run"
          disabled={busy}
        >
          {t("graphPatterns.template.run")}
        </button>
      </div>
      {ran ? null : <p className="field__hint">{t("graphPatterns.template.first")}</p>}
      {paste === null ? null : (
        <PasteValuesDialog
          name={name(paste)}
          type={paste.type}
          initial={typeof values[paste.name] === "string" ? (values[paste.name] as string) : ""}
          onAccept={(list) => onValues({ ...values, [paste.name]: list.join("\n") })}
          onClose={() => setPaste(null)}
        />
      )}
    </form>
  );
}

/** "Auswahl aus Werten": a field with the values of one property, searched on the server. */
function ChoiceField({
  id,
  orgId,
  analysisId,
  parameter,
  value,
  invalid,
  onChange,
}: {
  id: string;
  orgId: string;
  analysisId: string;
  parameter: string;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
}) {
  const { t } = useI18n();
  const search = useSettled(value, 250);
  const choices = useQuery({
    queryKey: ["graphPatterns", orgId, "choices", analysisId, parameter, search],
    queryFn: ({ signal }) => fetchChoices(orgId, analysisId, parameter, search, signal),
    staleTime: 60_000,
    retry: false,
    placeholderData: (previous) => previous,
  });
  const listId = `${id}-choices`;
  return (
    <>
      <input
        id={id}
        className="input"
        list={listId}
        value={value}
        autoComplete="off"
        aria-invalid={invalid ? true : undefined}
        aria-describedby={`${id}-hint`}
        onChange={(event) => onChange(event.currentTarget.value)}
      />
      <datalist id={listId}>
        {(choices.data?.values ?? []).map((v) => (
          <option key={String(v)} value={String(v)} />
        ))}
      </datalist>
      {choices.data?.more === true ? (
        <p className="field__hint">{t("graphPatterns.template.more")}</p>
      ) : null}
      {choices.isError ? (
        <p className="field__hint">{t("graphPatterns.template.choicesFailed")}</p>
      ) : null}
    </>
  );
}

/** "Über diese Suche" (frame 12): what the search does, its pattern and its query, to read. */
export function AboutTemplate({
  description,
  pattern,
  query: typed,
  compileOn,
  source,
  place,
  changed,
}: {
  description?: string | undefined;
  pattern?: Pattern | undefined;
  /** The query of a template from typed text. */
  query?: string | undefined;
  /** Where a pattern's query can be written, for those who may query its source. */
  compileOn?: { orgId: string; datasourceId: string } | undefined;
  source?: string | undefined;
  place: string;
  changed: string;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const compiled = useQuery({
    queryKey: ["graphPatterns", compileOn?.orgId, "compile", compileOn?.datasourceId, pattern],
    queryFn: ({ signal }) =>
      compilePattern(
        compileOn?.orgId ?? "",
        compileOn?.datasourceId ?? "",
        pattern as Pattern,
        {},
        signal,
      ),
    enabled: compileOn !== undefined && pattern !== undefined && typed === undefined,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  });
  const query = typed ?? compiled.data?.text;
  return (
    <aside className="pattern-about" aria-labelledby={`${id}-title`}>
      <h2 className="pattern-panel__title" id={`${id}-title`}>
        {t("graphPatterns.about.title")}
      </h2>
      {description === undefined ? null : <p>{description}</p>}
      {pattern === undefined ? null : (
        <>
          <p className="pattern__sentence">{patternSentence(t, language, pattern)}</p>
          <h3 className="pattern-schema__caption">{t("graphPatterns.about.pattern")}</h3>
          <PatternList pattern={pattern} selection={null} />
        </>
      )}
      {query === undefined || query === "" ? null : (
        <>
          <h3 className="pattern-schema__caption">{t("graphPatterns.about.query")}</h3>
          <pre className="pattern__text">{query}</pre>
          <p className="field__hint">{t("graphPatterns.about.queryHint")}</p>
        </>
      )}
      <h3 className="pattern-schema__caption">{t("graphPatterns.about.source")}</h3>
      <dl className="pattern-schema__properties">
        {source === undefined ? null : (
          <div>
            <dt>{t("graphPatterns.about.datasource")}</dt>
            <dd>{source}</dd>
          </div>
        )}
        <div>
          <dt>{t("graphPatterns.about.place")}</dt>
          <dd>{place}</dd>
        </div>
        <div>
          <dt>{t("graphPatterns.about.changed")}</dt>
          <dd>{changed}</dd>
        </div>
      </dl>
    </aside>
  );
}
