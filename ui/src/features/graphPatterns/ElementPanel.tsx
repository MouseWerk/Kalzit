import "../dashboards/ui/shared.css";
import "./patterns.css";
import { useId, useState } from "react";
import type {
  Condition,
  GraphSourceSchema,
  Match,
  Operand,
  Operator,
  Pattern,
  PatternEdge,
  PatternNode,
} from "../../api/generated/shapes";
import { Select } from "../../components/Select";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import {
  addEdge,
  addNode,
  DEFAULT_PATH,
  edgeById,
  edgeTypeChoices,
  isAlias,
  isParam,
  literalOf,
  nodeById,
  operatorsFor,
  type PatternDialect,
  propertiesOf,
  readValue,
  removeElement,
  renameElement,
  type Selection,
  takesValue,
  updateEdge,
  updateNode,
  type ValueKind,
  valueKind,
  valueText,
} from "./pattern";

/*
 * The side panel of the selected element (board Graph083, frames 1, 4 and 5): its type, its
 * conditions, for an edge its direction, length and whether it is optional, and its name in the
 * query. The same fields serve the list (frame 25) and the sheet on a phone (frame 26).
 */

export const KIND_TEXT: Record<ValueKind, MessageKey> = {
  text: "graphPatterns.kind.text",
  number: "graphPatterns.kind.number",
  date: "graphPatterns.kind.date",
  boolean: "graphPatterns.kind.boolean",
  list: "graphPatterns.kind.list",
  unknown: "graphPatterns.kind.unknown",
};

const OP_LABEL: Record<Operator, MessageKey> = {
  eq: "graphPatterns.op.eq",
  ne: "graphPatterns.op.ne",
  lt: "graphPatterns.op.lt",
  le: "graphPatterns.op.le",
  gt: "graphPatterns.op.gt",
  ge: "graphPatterns.op.ge",
  contains: "graphPatterns.op.contains",
  startsWith: "graphPatterns.op.startsWith",
  endsWith: "graphPatterns.op.endsWith",
  in: "graphPatterns.op.in",
  isNull: "graphPatterns.op.isNull",
  isNotNull: "graphPatterns.op.isNotNull",
};

/**
 * The operand a typed value is stored as: read in its type, or kept as typed when it does not fit,
 * so the field shows what is wrong and the run waits (`conditionError`).
 */
function operandFor(text: string, kind: ValueKind, op: Operator): Operand | undefined {
  const read = readValue(text, kind, op);
  if (read.operand !== undefined) return read.operand;
  return text.trim() === "" ? undefined : { value: text };
}

/** What does not fit in a condition's value, read from the pattern itself. */
export function conditionError(
  condition: Condition,
  kind: ValueKind,
): "empty" | "alias" | "number" | undefined {
  if (!takesValue(condition.op)) return undefined;
  if (condition.value === undefined) return "empty";
  if (isParam(condition.value)) return undefined;
  const value = literalOf(condition.value);
  if (typeof value === "string" && value.trim().startsWith("$")) return "alias";
  if (kind === "number") {
    const numbers = Array.isArray(value) ? value : [value];
    if (numbers.some((v) => typeof v !== "number")) return "number";
  }
  return undefined;
}

interface ElementPanelProps {
  pattern: Pattern;
  schema: GraphSourceSchema | undefined;
  dialect: PatternDialect;
  selection: Exclude<Selection, null>;
  onChange: (pattern: Pattern, select?: Selection, announce?: string) => void;
  /** Opens "Werte einfügen" for a list parameter. */
  onPaste: (parameter: string) => void;
}

export function ElementPanel(props: ElementPanelProps) {
  const { pattern, selection } = props;
  if (selection.kind === "node") {
    const node = nodeById(pattern, selection.id);
    return node === undefined ? null : <NodeFields {...props} node={node} />;
  }
  const edge = edgeById(pattern, selection.id);
  return edge === undefined ? null : <EdgeFields {...props} edge={edge} />;
}

function NodeFields({
  pattern,
  schema,
  dialect,
  node,
  onChange,
  onPaste,
}: ElementPanelProps & { node: PatternNode }) {
  const { t } = useI18n();
  const id = useId();
  const labels = node.labels ?? [];
  const [target, setTarget] = useState("");
  const others = pattern.nodes.filter((n) => n.id !== node.id);
  const several = dialect === "cypher";
  return (
    <div className="pattern-panel">
      <h3 className="pattern-panel__title" id={`${id}-title`}>
        {t("graphPatterns.panel.node", { id: node.id })}
      </h3>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-label`}>
          {t("graphPatterns.panel.type")}
        </label>
        {schema === undefined ? (
          <input
            id={`${id}-label`}
            className="input"
            value={labels.join(", ")}
            onChange={(event) => {
              const next = event.currentTarget.value
                .split(",")
                .map((l) => l.trim())
                .filter((l) => l !== "");
              onChange(updateNode(pattern, node.id, { labels: several ? next : next.slice(0, 1) }));
            }}
          />
        ) : (
          <Select
            id={`${id}-label`}
            value={labels[0] ?? ""}
            onChange={(label) =>
              onChange(
                updateNode(pattern, node.id, {
                  labels:
                    label === "" ? [] : [label, ...labels.slice(1).filter((l) => l !== label)],
                }),
              )
            }
          >
            <option value="">{t("graphPatterns.panel.anyNode")}</option>
            {labels[0] !== undefined && !schema.labels.some((l) => l.name === labels[0]) ? (
              <option value={labels[0]}>{labels[0]}</option>
            ) : null}
            {schema.labels.map((l) => (
              <option key={l.name} value={l.name}>
                {l.count === undefined
                  ? l.name
                  : t("graphPatterns.panel.labelCount", { name: l.name, count: l.count })}
              </option>
            ))}
          </Select>
        )}
        {several && labels.length > 1 ? (
          <ul className="pattern-panel__chips" aria-label={t("graphPatterns.panel.oneOf")}>
            {labels.map((label) => (
              <li key={label} className="pattern-panel__chip">
                {label}
                <button
                  type="button"
                  className="button button--ghost button--small"
                  aria-label={t("graphPatterns.panel.removeLabel", { label })}
                  onClick={() =>
                    onChange(
                      updateNode(pattern, node.id, { labels: labels.filter((l) => l !== label) }),
                    )
                  }
                >
                  {t("graphPatterns.panel.remove")}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        {several && schema !== undefined && labels.length > 0 ? (
          <Select
            aria-label={t("graphPatterns.panel.addLabel")}
            value=""
            onChange={(label) =>
              label === ""
                ? undefined
                : onChange(updateNode(pattern, node.id, { labels: [...labels, label] }))
            }
          >
            <option value="" hidden>
              {t("graphPatterns.panel.addLabel")}
            </option>
            {schema.labels
              .filter((l) => !labels.includes(l.name))
              .map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name}
                </option>
              ))}
          </Select>
        ) : null}
        <p className="field__hint">
          {t(several ? "graphPatterns.panel.typeHint" : "graphPatterns.panel.typeHintGsql")}
        </p>
      </div>
      <ConditionsFields
        owner={node.id}
        pattern={pattern}
        schema={schema}
        dialect={dialect}
        selection={{ kind: "node", id: node.id }}
        conditions={node.conditions ?? []}
        matches={node.matches ?? "all"}
        onChange={(conditions, matches) =>
          onChange(updateNode(pattern, node.id, { conditions, matches }))
        }
        onPaste={onPaste}
      />
      {others.length === 0 && pattern.nodes.length > 0 ? null : (
        <div className="field">
          <label className="field__label" htmlFor={`${id}-edge`}>
            {t("graphPatterns.panel.addEdge")}
          </label>
          <div className="pattern-panel__row">
            <Select id={`${id}-edge`} value={target} onChange={setTarget}>
              <option value="">{t("graphPatterns.panel.toNewNode")}</option>
              {others.map((n) => (
                <option key={n.id} value={n.id}>
                  {n.id}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => {
                let next = pattern;
                let to = target;
                if (to === "" || nodeById(next, to) === undefined) {
                  const added = addNode(next);
                  next = added.pattern;
                  to = added.id;
                }
                const edge = addEdge(next, node.id, to);
                onChange(
                  edge.pattern,
                  { kind: "edge", id: edge.id },
                  t("graphPatterns.announce.edgeAdded", { id: edge.id, from: node.id, to }),
                );
                setTarget("");
              }}
            >
              {t("graphPatterns.panel.addEdgeButton")}
            </button>
          </div>
        </div>
      )}
      <NameField
        pattern={pattern}
        current={node.id}
        onRename={(name) =>
          onChange(renameElement(pattern, node.id, name), { kind: "node", id: name })
        }
      />
      <RemoveButton
        pattern={pattern}
        selection={{ kind: "node", id: node.id }}
        onChange={onChange}
      />
    </div>
  );
}

function EdgeFields({
  pattern,
  schema,
  dialect,
  edge,
  onChange,
  onPaste,
}: ElementPanelProps & { edge: PatternEdge }) {
  const { t } = useI18n();
  const id = useId();
  const from = nodeById(pattern, edge.from)?.labels ?? [];
  const to = nodeById(pattern, edge.to)?.labels ?? [];
  const choices = edgeTypeChoices(schema, from, to);
  const types = edge.types ?? [];
  const path = (edge.maxHops ?? 1) > 1 || (edge.minHops ?? 1) > 1;
  const [hopsText, setHopsText] = useState({
    min: String(edge.minHops ?? DEFAULT_PATH.min),
    max: String(edge.maxHops ?? DEFAULT_PATH.max),
  });
  const hopsError =
    path &&
    (!/^\d+$/.test(hopsText.min) ||
      !/^\d+$/.test(hopsText.max) ||
      Number(hopsText.min) < 1 ||
      Number(hopsText.max) < Number(hopsText.min));
  const fromName = from.length === 0 ? edge.from : `${edge.from} (${from.join(" | ")})`;
  const toName = to.length === 0 ? edge.to : `${edge.to} (${to.join(" | ")})`;
  return (
    <div className="pattern-panel">
      <h3 className="pattern-panel__title" id={`${id}-title`}>
        {t("graphPatterns.panel.edge", { id: edge.id, types: types.join(" | ") || "" }).trim()}
      </h3>
      <fieldset className="pattern-panel__choices">
        <legend className="field__label">{t("graphPatterns.panel.direction")}</legend>
        {(
          [
            ["out", t("graphPatterns.panel.directionOut", { from: edge.from, to: edge.to })],
            ["in", t("graphPatterns.panel.directionIn", { from: edge.from, to: edge.to })],
            ["both", t("graphPatterns.panel.directionBoth")],
          ] as const
        ).map(([value, label]) => (
          <label key={value} className="radio">
            <input
              type="radio"
              name={`${id}-direction`}
              checked={edge.direction === value}
              onChange={() => onChange(updateEdge(pattern, edge.id, { direction: value }))}
            />
            {label}
          </label>
        ))}
      </fieldset>
      <div className="field">
        <label className="field__label" htmlFor={`${id}-type`}>
          {t("graphPatterns.panel.type")}
        </label>
        {schema === undefined ? (
          <input
            id={`${id}-type`}
            className="input"
            value={types.join(", ")}
            onChange={(event) =>
              onChange(
                updateEdge(pattern, edge.id, {
                  types: event.currentTarget.value
                    .split(",")
                    .map((v) => v.trim())
                    .filter((v) => v !== ""),
                }),
              )
            }
          />
        ) : (
          <Select
            id={`${id}-type`}
            value={types[0] ?? ""}
            onChange={(type) =>
              onChange(updateEdge(pattern, edge.id, { types: type === "" ? [] : [type] }))
            }
          >
            <option value="">{t("graphPatterns.panel.anyType")}</option>
            {types[0] !== undefined &&
            !choices.between.some((c) => c.type === types[0]) &&
            !choices.other.includes(types[0]) ? (
              <option value={types[0]}>{types[0]}</option>
            ) : null}
            {choices.between.length === 0 ? null : (
              <optgroup
                label={t("graphPatterns.panel.between", {
                  from: from.join(" | ") || t("graphPatterns.panel.anyNode"),
                  to: to.join(" | ") || t("graphPatterns.panel.anyNode"),
                })}
              >
                {[...new Set(choices.between.map((c) => c.type))].map((type) => {
                  const link = choices.between.find((c) => c.type === type);
                  return (
                    <option key={type} value={type}>
                      {link === undefined
                        ? type
                        : link.count === undefined
                          ? t("graphPatterns.panel.link", { type, from: link.from, to: link.to })
                          : t("graphPatterns.panel.linkCount", {
                              type,
                              from: link.from,
                              to: link.to,
                              count: link.count,
                            })}
                    </option>
                  );
                })}
              </optgroup>
            )}
            {choices.other.length === 0 ? null : (
              <optgroup label={t("graphPatterns.panel.notBetween")}>
                {choices.other.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </optgroup>
            )}
          </Select>
        )}
        <p className="field__hint">
          {t("graphPatterns.panel.typeEdgeHint", { from: fromName, to: toName })}
        </p>
      </div>
      <fieldset className="pattern-panel__choices">
        <legend className="field__label">{t("graphPatterns.panel.length")}</legend>
        <label className="radio">
          <input
            type="radio"
            name={`${id}-length`}
            checked={!path}
            onChange={() => onChange(updateEdge(pattern, edge.id, { minHops: 1, maxHops: 1 }))}
          />
          {t("graphPatterns.panel.lengthOne")}
        </label>
        <label className="radio">
          <input
            type="radio"
            name={`${id}-length`}
            checked={path}
            onChange={() => {
              setHopsText({ min: String(DEFAULT_PATH.min), max: String(DEFAULT_PATH.max) });
              onChange(
                updateEdge(pattern, edge.id, {
                  minHops: DEFAULT_PATH.min,
                  maxHops: DEFAULT_PATH.max,
                  conditions: [],
                }),
              );
            }}
          />
          {t("graphPatterns.panel.lengthRange")}
        </label>
        {path ? (
          <div className="pattern-panel__row">
            {(["min", "max"] as const).map((end) => (
              <label key={end} className="pattern-panel__hops">
                {t(end === "min" ? "graphPatterns.panel.from" : "graphPatterns.panel.to")}
                <input
                  className="input pattern-panel__number"
                  inputMode="numeric"
                  value={hopsText[end]}
                  aria-invalid={hopsError ? true : undefined}
                  aria-describedby={`${id}-hops`}
                  onChange={(event) => {
                    const text = event.currentTarget.value;
                    const next = { ...hopsText, [end]: text };
                    setHopsText(next);
                    const min = Number(next.min);
                    const max = Number(next.max);
                    if (
                      /^\d+$/.test(next.min) &&
                      /^\d+$/.test(next.max) &&
                      min >= 1 &&
                      max >= min
                    ) {
                      onChange(updateEdge(pattern, edge.id, { minHops: min, maxHops: max }));
                    }
                  }}
                />
              </label>
            ))}
          </div>
        ) : null}
        <p className={hopsError ? "field__error" : "field__hint"} id={`${id}-hops`}>
          {t(hopsError ? "graphPatterns.panel.hopsInvalid" : "graphPatterns.panel.lengthHint")}
        </p>
      </fieldset>
      <div className="field">
        <label className="checkbox">
          <input
            type="checkbox"
            checked={edge.optional === true}
            onChange={(event) =>
              onChange(updateEdge(pattern, edge.id, { optional: event.currentTarget.checked }))
            }
          />
          {t("graphPatterns.panel.optional")}
        </label>
        {dialect === "gsql" && edge.optional === true ? (
          <div className="pattern-note" role="note">
            <p>{t("graphPatterns.panel.gsqlOptional")}</p>
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => onChange(updateEdge(pattern, edge.id, { optional: false }))}
            >
              {t("graphPatterns.panel.makeRequired")}
            </button>
          </div>
        ) : (
          <p className="field__hint">{t("graphPatterns.panel.optionalHint")}</p>
        )}
      </div>
      {path ? (
        <p className="field__hint">{t("graphPatterns.panel.pathNoConditions")}</p>
      ) : (
        <ConditionsFields
          owner={edge.id}
          pattern={pattern}
          schema={schema}
          dialect={dialect}
          selection={{ kind: "edge", id: edge.id }}
          conditions={edge.conditions ?? []}
          matches={edge.matches ?? "all"}
          onChange={(conditions, matches) =>
            onChange(updateEdge(pattern, edge.id, { conditions, matches }))
          }
          onPaste={onPaste}
        />
      )}
      <NameField
        pattern={pattern}
        current={edge.id}
        onRename={(name) =>
          onChange(renameElement(pattern, edge.id, name), { kind: "edge", id: name })
        }
      />
      <RemoveButton
        pattern={pattern}
        selection={{ kind: "edge", id: edge.id }}
        onChange={onChange}
      />
    </div>
  );
}

function ConditionsFields({
  owner,
  pattern,
  schema,
  dialect,
  selection,
  conditions,
  matches,
  onChange,
  onPaste,
}: {
  owner: string;
  pattern: Pattern;
  schema: GraphSourceSchema | undefined;
  dialect: PatternDialect;
  selection: Exclude<Selection, null>;
  conditions: Condition[];
  matches: Match;
  onChange: (conditions: Condition[], matches: Match) => void;
  onPaste: (parameter: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const properties = propertiesOf(pattern, schema, selection);
  const set = (index: number, condition: Condition) =>
    onChange(
      conditions.map((c, i) => (i === index ? condition : c)),
      matches,
    );
  return (
    <fieldset className="pattern-panel__conditions">
      <legend className="field__label">{t("graphPatterns.panel.conditions")}</legend>
      {conditions.length > 1 ? (
        <div
          className="pattern-panel__row"
          role="radiogroup"
          aria-label={t("graphPatterns.panel.matches")}
        >
          <span>{t("graphPatterns.panel.matches")}</span>
          {(["all", "any"] as const).map((value) => (
            <label key={value} className="radio">
              <input
                type="radio"
                name={`${id}-matches`}
                checked={matches === value}
                onChange={() => onChange(conditions, value)}
              />
              {t(value === "all" ? "graphPatterns.panel.matchAll" : "graphPatterns.panel.matchAny")}
            </label>
          ))}
        </div>
      ) : null}
      {conditions.length === 0 ? (
        <p className="field__hint">{t("graphPatterns.panel.noConditions")}</p>
      ) : (
        <ul className="pattern-panel__list">
          {conditions.map((condition, index) => (
            <ConditionRow
              // biome-ignore lint/suspicious/noArrayIndexKey: conditions have no id; their place is it
              key={`${owner}-${index}`}
              owner={owner}
              condition={condition}
              properties={properties}
              dialect={dialect}
              onChange={(next) => set(index, next)}
              onRemove={() =>
                onChange(
                  conditions.filter((_, i) => i !== index),
                  matches,
                )
              }
              onPaste={onPaste}
            />
          ))}
        </ul>
      )}
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => {
          const first = properties[0];
          const kind = valueKind(first?.types);
          const op = operatorsFor(kind, dialect)[0] ?? "eq";
          onChange([...conditions, { property: first?.name ?? "", op }], matches);
        }}
      >
        {t("graphPatterns.panel.addCondition")}
      </button>
      <p className="field__hint">{t("graphPatterns.panel.conditionsHint")}</p>
    </fieldset>
  );
}

function ConditionRow({
  owner,
  condition,
  properties,
  dialect,
  onChange,
  onRemove,
  onPaste,
}: {
  owner: string;
  condition: Condition;
  properties: { name: string; types: string[] }[];
  dialect: PatternDialect;
  onChange: (condition: Condition) => void;
  onRemove: () => void;
  onPaste: (parameter: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const known = properties.find((p) => p.name === condition.property);
  const kind = valueKind(known?.types);
  const ops = operatorsFor(kind, dialect);
  // A boolean property says "is true" and "is false" instead of a value.
  const boolean = kind === "boolean";
  const opValue =
    boolean && condition.op === "eq"
      ? literalOf(condition.value) === false
        ? "false"
        : "true"
      : condition.op;
  // The text as typed while it still reads as the stored value, so "1." stays while typing.
  const [typed, setTyped] = useState<string | null>(null);
  const stored = valueText(condition.value);
  const shown =
    typed !== null &&
    JSON.stringify(operandFor(typed, kind, condition.op)) === JSON.stringify(condition.value)
      ? typed
      : stored;
  const error = conditionError(condition, kind);
  const errorText =
    error === undefined
      ? undefined
      : error === "number"
        ? t("graphPatterns.condition.notNumber", { property: condition.property, value: stored })
        : error === "alias"
          ? t("graphPatterns.condition.badName")
          : t("graphPatterns.condition.empty");
  const param = isParam(condition.value) ? condition.value.param : undefined;
  return (
    <li className="pattern-panel__condition">
      <div className="pattern-panel__row">
        {properties.length === 0 ? (
          <input
            className="input"
            aria-label={t("graphPatterns.condition.property")}
            value={condition.property}
            onChange={(event) => onChange({ ...condition, property: event.currentTarget.value })}
          />
        ) : (
          <Select
            aria-label={t("graphPatterns.condition.property")}
            value={condition.property}
            onChange={(property) => {
              const nextKind = valueKind(properties.find((p) => p.name === property)?.types);
              const nextOps = operatorsFor(nextKind, dialect);
              const op = nextOps.includes(condition.op) ? condition.op : (nextOps[0] ?? "eq");
              onChange({ ...condition, property, op });
            }}
          >
            {known === undefined ? (
              <option value={condition.property}>{condition.property}</option>
            ) : null}
            {properties.map((p) => (
              <option key={p.name} value={p.name}>
                {t("graphPatterns.condition.propertyType", {
                  name: p.name,
                  type: t(KIND_TEXT[valueKind(p.types)]),
                })}
              </option>
            ))}
          </Select>
        )}
        <Select
          aria-label={t("graphPatterns.condition.op")}
          value={opValue}
          onChange={(next) => {
            if (next === "true" || next === "false") {
              onChange({ ...condition, op: "eq", value: { value: next === "true" } });
              return;
            }
            const op = next as Operator;
            const value: Operand | undefined = takesValue(op) ? condition.value : undefined;
            const out: Condition = { property: condition.property, op };
            if (value !== undefined) out.value = value;
            onChange(out);
          }}
        >
          {boolean ? (
            <>
              <option value="true">{t("graphPatterns.op.isTrue")}</option>
              <option value="false">{t("graphPatterns.op.isFalse")}</option>
            </>
          ) : null}
          {ops
            .filter((op) => !(boolean && op === "eq"))
            .map((op) => (
              <option key={op} value={op}>
                {t(OP_LABEL[op])}
              </option>
            ))}
        </Select>
        {takesValue(condition.op) && !boolean ? (
          <input
            id={`${id}-value`}
            className="input"
            aria-label={t("graphPatterns.condition.value")}
            value={shown}
            aria-invalid={error === undefined ? undefined : true}
            aria-describedby={error === undefined ? `${id}-hint` : `${id}-error`}
            onChange={(event) => {
              const text = event.currentTarget.value;
              setTyped(text);
              const out: Condition = { property: condition.property, op: condition.op };
              const operand = operandFor(text, kind, condition.op);
              if (operand !== undefined) out.value = operand;
              onChange(out);
            }}
          />
        ) : null}
        <button
          type="button"
          className="button button--ghost button--small"
          aria-label={t("graphPatterns.condition.removeNamed", {
            property: condition.property || owner,
          })}
          onClick={onRemove}
        >
          {t("graphPatterns.condition.remove")}
        </button>
      </div>
      {takesValue(condition.op) && !boolean ? (
        <div className="pattern-panel__row">
          {param === undefined ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => {
                const name = isAlias(condition.property) ? condition.property : `wert_${owner}`;
                setTyped(null);
                onChange({ ...condition, value: { param: name } });
              }}
            >
              {t("graphPatterns.condition.asVariable")}
            </button>
          ) : condition.op === "in" ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onPaste(param)}
            >
              {t("graphPatterns.condition.paste")}
            </button>
          ) : null}
        </div>
      ) : null}
      {errorText === undefined ? (
        <p className="field__hint" id={`${id}-hint`}>
          {t("graphPatterns.condition.hint")}
        </p>
      ) : (
        <p className="field__error" id={`${id}-error`}>
          {errorText}
        </p>
      )}
    </li>
  );
}

function NameField({
  pattern,
  current,
  onRename,
}: {
  pattern: Pattern;
  current: string;
  onRename: (name: string) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(current);
  const taken =
    text !== current &&
    [
      ...pattern.nodes.map((n) => n.id),
      ...(pattern.edges ?? []).map((e) => e.id),
      ...(pattern.parameters ?? []).map((p) => p.name),
    ]
      .map((n) => n.toLowerCase())
      .includes(text.toLowerCase());
  const error = !isAlias(text)
    ? t("graphPatterns.panel.nameInvalid")
    : taken
      ? t("graphPatterns.panel.nameTaken", { name: text })
      : undefined;
  return (
    <div className="field">
      <label className="field__label" htmlFor={`${id}-name`}>
        {t("graphPatterns.panel.name")}
      </label>
      <input
        id={`${id}-name`}
        className="input pattern-panel__name"
        value={text}
        aria-invalid={error === undefined ? undefined : true}
        aria-describedby={`${id}-name-hint`}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
        }}
        onBlur={() => {
          if (error === undefined && text !== current) onRename(text);
        }}
        onKeyDown={(event) => {
          if (
            !isComposingKey(event) &&
            event.key === "Enter" &&
            error === undefined &&
            text !== current
          )
            onRename(text);
        }}
      />
      <p className={error === undefined ? "field__hint" : "field__error"} id={`${id}-name-hint`}>
        {error ?? t("graphPatterns.panel.nameHint")}
      </p>
    </div>
  );
}

function RemoveButton({
  pattern,
  selection,
  onChange,
}: {
  pattern: Pattern;
  selection: Exclude<Selection, null>;
  onChange: (pattern: Pattern, select?: Selection, announce?: string) => void;
}) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      className="button button--secondary button--small"
      onClick={() =>
        onChange(
          removeElement(pattern, selection),
          null,
          t("graphPatterns.announce.removed", { id: selection.id }),
        )
      }
    >
      {t(
        selection.kind === "node"
          ? "graphPatterns.panel.removeNode"
          : "graphPatterns.panel.removeEdge",
      )}
    </button>
  );
}
