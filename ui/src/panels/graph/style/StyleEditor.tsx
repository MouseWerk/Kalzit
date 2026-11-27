import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { Icon } from "../../../components/Icon";
import { IconButton } from "../../../components/IconButton";
import { Select } from "../../../components/Select";
import { ConfirmDialog } from "../../../features/dashboards/ui/Dialog";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { KEYS_SLOT, KeysInText } from "../../../shortcuts/Keys";
import { matchesShortcut, shortcutProps } from "../../../shortcuts/registry";
import { countText } from "../plural";
import { SHIFTED_DASH, shiftedShape } from "./apply";
import { opText, reportText, ruleSentence } from "./describe";
import {
  conditionProblem,
  type Evaluation,
  evaluateRules,
  guessType,
  type StyleItem,
} from "./evaluate";
import { IconPicker } from "./IconPicker";
import { EdgeSwatch, IconGlyph, NodeSwatch } from "./Swatch";
import {
  CONDITION_OPS,
  type Condition,
  type ConditionOp,
  copyStyle,
  EDGE_ARROWS,
  EDGE_DASHES,
  EDGE_TARGETS,
  type EdgeTargets,
  type GraphStyle,
  isNewerStyle,
  MAX_BADGE_CHARS,
  MAX_RULE_TEXT,
  MAX_STYLE_RULES,
  NODE_TARGETS,
  type NodeTargets,
  newRuleId,
  operands,
  RULE_BORDERS,
  RULE_SHAPES,
  RULE_SIZE,
  RULE_WIDTH,
  type RuleShape,
  type RuleWhen,
  readableStyle,
  ruleCount,
  STATUS_COLORS,
  STYLE_COLORS,
  type StyleColor,
  type StyleRule,
  VALUE_TYPES,
  type ValueType,
} from "./schema";
import type { StyleVocabulary } from "./useGraphStyle";
import "../graph.css";
import "./style.css";

/**
 * The editor of a panel's style rules (Graph081 board, frames 8 to 10): the basis in words, the
 * rule list of nodes and of edges, each rule as a sentence with how many it hits, and the open
 * rule with its condition and targets. The same editor is the panel editor's section "Stil" and
 * the sheet "Stil" of a viewed panel. Order: the lower rule wins on the same target; Alt+Up and
 * Alt+Down move the rule that has the focus.
 */

type Kind = "nodes" | "edges";
type AnyRule = StyleRule<NodeTargets & EdgeTargets>;
type TargetKey = keyof NodeTargets | keyof EdgeTargets;

export interface StyleEditorProps {
  /** The rules (a prop named `style` would read as an inline style). */
  rules: GraphStyle;
  onChange: (style: GraphStyle) => void;
  /** The nodes and edges of the current result, which the counts come from; null without one. */
  items: { nodes: readonly StyleItem[]; edges: readonly StyleItem[] } | null;
  vocabulary: StyleVocabulary | null;
  /** The basis in words (color, size, shape); absent where the panel has none (a table). */
  basis?: { color: string; size: string; shape: string } | undefined;
  /** Other panels of the dashboard with rules, for "Regeln von anderem Panel übernehmen". */
  copySources?: readonly { id: string; title: string; style: GraphStyle }[] | undefined;
  /** Announces a change for screen readers (a copy, a move). */
  onAnnounce?: ((text: string) => void) | undefined;
}

const NO_ITEMS: readonly StyleItem[] = [];

type CopySource = { id: string; title: string; style: GraphStyle };

export function StyleEditor({
  rules: style,
  onChange,
  items,
  vocabulary,
  basis,
  copySources = [],
  onAnnounce,
}: StyleEditorProps) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const [kind, setKind] = useState<Kind>("nodes");
  const [open, setOpen] = useState<string | null>(null);
  const [copyFrom, setCopyFrom] = useState("");
  const [said, setSaid] = useState("");
  const [focusRule, setFocusRule] = useState<string | null>(null);
  const [confirmCopy, setConfirmCopy] = useState<CopySource | null>(null);
  const copy = (source: CopySource) => {
    onChange(copyStyle(source.style));
    setOpen(null);
    setConfirmCopy(null);
    say(t("graphStyle.copy.done", { title: source.title }));
  };
  const copyId = useId();
  const listId = useId();
  const say = (text: string) => {
    setSaid(text);
    onAnnounce?.(text);
  };
  const evaluation = useMemo(() => {
    const evaluated = (rules: readonly AnyRule[], list: readonly StyleItem[] | undefined) =>
      list === undefined ? null : evaluateRules(rules, list);
    const readable = readableStyle(style);
    return {
      nodes: evaluated(readable.nodes, items?.nodes),
      edges: evaluated(readable.edges, items?.edges),
    };
  }, [style, items]);
  const newer = isNewerStyle(style);
  const rules = (newer ? [] : kind === "nodes" ? style.nodes : style.edges) as AnyRule[];
  const reports: Evaluation | null = evaluation[kind];
  const full = ruleCount(style) >= MAX_STYLE_RULES;

  const setRules = (next: AnyRule[]) => onChange({ ...style, [kind]: next } as GraphStyle);
  const update = (index: number, rule: AnyRule) =>
    setRules(rules.map((r, i) => (i === index ? rule : r)));
  const move = (index: number, by: -1 | 1) => {
    const to = index + by;
    if (to < 0 || to >= rules.length) return;
    const next = [...rules];
    const [rule] = next.splice(index, 1);
    next.splice(to, 0, rule as AnyRule);
    setRules(next);
    // The moved rule keeps the focus on its header, wherever the list puts it.
    setFocusRule((rule as AnyRule).id);
    say(t("graphStyle.announce.moved", { from: index + 1, to: to + 1 }));
  };
  const add = () => {
    if (full) return;
    const id = newRuleId(style);
    setRules([...rules, { id, on: true, scope: "", when: { kind: "always" }, set: {} }]);
    setOpen(id);
  };
  const duplicate = (index: number) => {
    if (full) return;
    const rule = rules[index] as AnyRule;
    const copy = { ...structuredClone(rule), id: newRuleId(style) };
    setRules([...rules.slice(0, index + 1), copy, ...rules.slice(index + 1)]);
    setOpen(copy.id);
  };
  const remove = (index: number) => {
    setRules(rules.filter((_, i) => i !== index));
    setOpen(null);
    say(t("graphStyle.announce.removed", { rule: index + 1 }));
  };
  const keys = (scope: string): string[] => {
    const map = kind === "nodes" ? vocabulary?.nodeKeys : vocabulary?.edgeKeys;
    return map?.get(scope) ?? map?.get("") ?? [];
  };
  const kindItems = (kind === "nodes" ? items?.nodes : items?.edges) ?? NO_ITEMS;
  const sources = copySources.filter((source) => ruleCount(source.style) > 0);
  if (newer) {
    // Rules of a newer Kalzit stay as they are: editing them here would write the older form.
    return <p className="field__hint">{t("graphStyle.newer")}</p>;
  }

  return (
    <div className="graph-style-editor">
      {confirmCopy === null ? null : (
        <ConfirmDialog
          title={t("graphStyle.copy.confirmTitle")}
          confirmLabel={t("graphStyle.copy.apply")}
          onConfirm={() => copy(confirmCopy)}
          onCancel={() => setConfirmCopy(null)}
        >
          {t("graphStyle.copy.confirm", {
            count: ruleCount(style),
            title: confirmCopy.title,
          })}
        </ConfirmDialog>
      )}
      <p className="field__hint">{t("graphStyle.forGraphData")}</p>
      {sources.length > 0 ? (
        <div className="graph-style-editor__copy">
          <label className="field__label" htmlFor={copyId}>
            {t("graphStyle.copy.label")}
          </label>
          <div className="graph-style-editor__row">
            <Select id={copyId} value={copyFrom} onChange={setCopyFrom}>
              <option value="">{t("graphStyle.copy.pick")}</option>
              {sources.map((source) => (
                <option key={source.id} value={source.id}>
                  {source.title === "" ? t("graphStyle.copy.untitled") : source.title}
                </option>
              ))}
            </Select>
            <button
              type="button"
              className="button button--secondary button--small"
              disabled={copyFrom === ""}
              onClick={() => {
                const source = sources.find((s) => s.id === copyFrom);
                if (source === undefined) return;
                // Rules of this panel would be replaced: asked first.
                if (ruleCount(style) > 0) setConfirmCopy(source);
                else copy(source);
              }}
            >
              {t("graphStyle.copy.apply")}
            </button>
          </div>
          <p className="field__hint">{t("graphStyle.copy.hint")}</p>
        </div>
      ) : null}
      {basis === undefined ? null : (
        <dl className="graph-style-editor__basis">
          <dt>{t("graphStyle.basis.color")}</dt>
          <dd>{basis.color}</dd>
          <dt>{t("graphStyle.basis.size")}</dt>
          <dd>{basis.size}</dd>
          <dt>{t("graphStyle.basis.shape")}</dt>
          <dd>{basis.shape}</dd>
        </dl>
      )}
      <div className="graph-style-editor__head">
        {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a field set */}
        <div className="graph__segmented" role="group" aria-label={t("graphStyle.kind.label")}>
          {(["nodes", "edges"] as const).map((k) => (
            <button
              key={k}
              type="button"
              className="graph__segment"
              aria-pressed={kind === k}
              onClick={() => {
                setKind(k);
                setOpen(null);
              }}
            >
              {t(`graphStyle.kind.${k}`)}{" "}
              <span className="graph-legend__count">
                {number.format((k === "nodes" ? style.nodes : style.edges).length)}
              </span>
            </button>
          ))}
        </div>
        <button
          type="button"
          className="button button--secondary button--small"
          disabled={full}
          title={full ? t("graphStyle.limit", { max: MAX_STYLE_RULES }) : undefined}
          onClick={add}
        >
          <Icon name="plus" />
          {t("graphStyle.add")}
        </button>
      </div>
      {full ? (
        <p className="field__hint">{t("graphStyle.limit", { max: MAX_STYLE_RULES })}</p>
      ) : null}
      {rules.length === 0 ? (
        <div className="graph-style-editor__empty">
          <p className="graph-style-editor__empty-title">{t("graphStyle.empty.title")}</p>
          <p className="field__hint">
            {t(kind === "nodes" ? "graphStyle.empty.nodes" : "graphStyle.empty.edges")}
          </p>
        </div>
      ) : (
        <ol className="graph-style-editor__list" id={listId}>
          {rules.map((rule, index) => (
            <RuleRow
              key={rule.id}
              kind={kind}
              rule={rule}
              index={index}
              count={rules.length}
              report={reports?.rules[index]}
              open={open === rule.id}
              number={number}
              onToggleOpen={() => setOpen(open === rule.id ? null : rule.id)}
              onChange={(next) => update(index, next)}
              onMove={(by) => move(index, by)}
              onDuplicate={full ? null : () => duplicate(index)}
              onRemove={() => remove(index)}
              keys={keys(rule.scope)}
              scopes={(kind === "nodes" ? vocabulary?.labels : vocabulary?.edgeTypes) ?? []}
              items={kindItems}
              ruleNames={(r) => t("graphStyle.rule.number", { n: r + 1 })}
              focus={focusRule === rule.id}
              onFocused={() => setFocusRule(null)}
            />
          ))}
        </ol>
      )}
      <p className="field__hint">
        <KeysInText text={t("graphStyle.order", { keys: KEYS_SLOT })} id="graphStyle.move" />
      </p>
      <p className="visually-hidden" role="status">
        {said}
      </p>
    </div>
  );
}

function RuleRow({
  kind,
  rule,
  index,
  count,
  report,
  open,
  number,
  onToggleOpen,
  onChange,
  onMove,
  onDuplicate,
  onRemove,
  keys,
  scopes,
  items,
  ruleNames,
  focus,
  onFocused,
}: {
  /** Puts the focus on the rule's header (after a move). */
  focus: boolean;
  onFocused: () => void;
  kind: Kind;
  rule: AnyRule;
  index: number;
  count: number;
  report: Evaluation["rules"][number] | undefined;
  open: boolean;
  number: Intl.NumberFormat;
  onToggleOpen: () => void;
  onChange: (rule: AnyRule) => void;
  onMove: (by: -1 | 1) => void;
  onDuplicate: (() => void) | null;
  onRemove: () => void;
  keys: string[];
  scopes: string[];
  items: readonly StyleItem[];
  ruleNames: (rule: number) => string;
}) {
  const { t, language } = useI18n();
  const formId = useId();
  const sentence = ruleSentence(t, rule, kind);
  const state = reportText(t, rule, report, (n) => number.format(n));
  const overridden = rule.on ? (report?.overridden ?? []) : [];
  const headerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    headerRef.current?.focus();
    onFocused();
  }, [focus, onFocused]);
  // Alt+Up and Alt+Down move the rule from its header only: inside the open rule, a select keeps
  // Alt+Down for opening its list.
  const onKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    const up = matchesShortcut("graphStyle.moveUp", event);
    if (!up && !matchesShortcut("graphStyle.moveDown", event)) return;
    event.preventDefault();
    onMove(up ? -1 : 1);
  };
  return (
    <li
      className={`graph-style-rule${rule.on ? "" : " graph-style-rule--off"}${open ? " graph-style-rule--open" : ""}`}
    >
      <div className="graph-style-rule__line">
        <span className="graph-style-rule__number" aria-hidden="true">
          {index + 1}
        </span>
        <RuleSwatch rule={rule} kind={kind} />
        <button
          type="button"
          ref={headerRef}
          className="graph-style-rule__text"
          {...shortcutProps("graphStyle.move")}
          onKeyDown={onKey}
          aria-expanded={open}
          aria-controls={open ? formId : undefined}
          onClick={onToggleOpen}
        >
          <span className="visually-hidden">{ruleNames(index)}: </span>
          {sentence}
        </button>
        <span
          className={`graph-style-rule__state${report?.state === "dormant" || report?.state === "invalid" ? " graph-style-rule__state--rest" : ""}`}
        >
          {state}
        </span>
        <label className="graph-style-rule__switch">
          <input
            type="checkbox"
            checked={rule.on}
            onChange={(event) => onChange({ ...rule, on: event.currentTarget.checked })}
          />
          <span className="visually-hidden">{t("graphStyle.rule.on", { n: index + 1 })}</span>
        </label>
        <IconButton
          icon="arrowUp"
          label={t("graphStyle.rule.up")}
          shortcut="graphStyle.moveUp"
          disabled={index === 0}
          onClick={() => onMove(-1)}
        />
        <IconButton
          icon="arrowDown"
          label={t("graphStyle.rule.down")}
          shortcut="graphStyle.moveDown"
          disabled={index === count - 1}
          onClick={() => onMove(1)}
        />
      </div>
      {overridden.length > 0 ? (
        <p className="graph-style-rule__note">
          {overridden
            .map((o) =>
              t("graphStyle.state.overridden", {
                items: countText(t, language, kind === "nodes" ? "node" : "edge", o.count),
                rule: o.by + 1,
              }),
            )
            .join(" · ")}
        </p>
      ) : null}
      {open ? (
        <RuleForm
          id={formId}
          kind={kind}
          rule={rule}
          index={index}
          report={report}
          number={number}
          keys={keys}
          scopes={scopes}
          items={items}
          onChange={onChange}
          onDuplicate={onDuplicate}
          onRemove={onRemove}
          onDone={onToggleOpen}
        />
      ) : null}
    </li>
  );
}

/** What a rule draws, small: a node or an edge in its look, with its icon or badge. */
function RuleSwatch({ rule, kind }: { rule: AnyRule; kind: Kind }) {
  const set = rule.set;
  if (kind === "edges") {
    return (
      <span className="graph-style-rule__swatch">
        <EdgeSwatch
          color={rule.when.kind === "values" ? "chart-1" : set.color}
          dash={set.dash}
          width={set.width}
        />
      </span>
    );
  }
  return (
    <span className="graph-style-rule__swatch">
      <NodeSwatch
        color={rule.when.kind === "values" ? "chart-1" : set.color}
        shape={set.shape}
        border={set.border}
      />
      {set.icon === undefined ? null : <IconGlyph name={set.icon} />}
    </span>
  );
}

const WHEN_KINDS = ["condition", "values", "always"] as const;

function RuleForm({
  id,
  kind,
  rule,
  index,
  report,
  number,
  keys,
  scopes,
  items,
  onChange,
  onDuplicate,
  onRemove,
  onDone,
}: {
  id: string;
  kind: Kind;
  rule: AnyRule;
  index: number;
  report: Evaluation["rules"][number] | undefined;
  number: Intl.NumberFormat;
  keys: string[];
  scopes: string[];
  items: readonly StyleItem[];
  onChange: (rule: AnyRule) => void;
  onDuplicate: (() => void) | null;
  onRemove: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const scopeId = useId();
  const keysId = useId();
  const targetId = useId();
  const when = rule.when;
  const scopeChoices =
    rule.scope === "" || scopes.includes(rule.scope) ? scopes : [...scopes, rule.scope];
  const setWhen = (next: RuleWhen) => onChange({ ...rule, when: next });
  const property = when.kind === "always" ? "" : when.property;
  const startWhen = (kindOf: (typeof WHEN_KINDS)[number]): RuleWhen => {
    if (kindOf === "always") return { kind: "always" };
    const key = property === "" ? (keys[0] ?? "") : property;
    if (kindOf === "values") return { kind: "values", property: key, colors: [] };
    const type = guessType(items, key, rule.scope);
    return {
      kind: "condition",
      property: key,
      type,
      op: CONDITION_OPS[type][0] as ConditionOp,
      value: "",
      to: "",
      caseSensitive: false,
    };
  };
  const targetList = (kind === "nodes" ? NODE_TARGETS : EDGE_TARGETS) as readonly TargetKey[];
  const set = rule.set as Record<TargetKey, unknown>;
  const free = targetList.filter(
    (key) => set[key] === undefined && !(key === "color" && when.kind === "values"),
  );
  const setTarget = (key: TargetKey, value: unknown) => {
    const next = { ...rule.set } as Record<string, unknown>;
    if (value === undefined) delete next[key];
    else next[key] = value;
    onChange({ ...rule, set: next as AnyRule["set"] });
  };
  const status =
    rule.set.color !== undefined &&
    STATUS_COLORS.includes(rule.set.color) &&
    rule.set.badge === undefined &&
    rule.set.shape === undefined &&
    rule.set.icon === undefined;

  return (
    <section
      className="graph-style-form"
      id={id}
      aria-label={t("graphStyle.rule.number", { n: index + 1 })}
    >
      <p className="graph-style-form__count">
        {report === undefined
          ? null
          : t("graphStyle.form.matches", {
              count: number.format(report.matched),
              total: number.format(report.inScope),
            })}
      </p>
      <div className="field">
        <label className="field__label" htmlFor={scopeId}>
          {t(kind === "nodes" ? "graphStyle.form.label" : "graphStyle.form.edgeType")}
        </label>
        <Select id={scopeId} value={rule.scope} onChange={(scope) => onChange({ ...rule, scope })}>
          <option value="">
            {t(kind === "nodes" ? "graphStyle.scope.allNodes" : "graphStyle.scope.allEdges")}
          </option>
          {scopeChoices.map((scope) => (
            <option key={scope} value={scope}>
              {scope}
            </option>
          ))}
        </Select>
      </div>
      <fieldset className="graph-style-form__group">
        <legend className="field__label">{t("graphStyle.form.when")}</legend>
        {/* biome-ignore lint/a11y/useSemanticElements: toggle buttons inside the field set */}
        <div className="graph__segmented" role="group" aria-label={t("graphStyle.form.when")}>
          {WHEN_KINDS.map((k) => (
            <button
              key={k}
              type="button"
              className="graph__segment"
              aria-pressed={when.kind === k}
              onClick={() => {
                if (when.kind !== k) setWhen(startWhen(k));
              }}
            >
              {t(`graphStyle.when.kind.${k}`)}
            </button>
          ))}
        </div>
        {when.kind === "always" ? null : (
          <>
            <TextField
              label={t("graphStyle.form.property")}
              value={when.property}
              list={keysId}
              mono
              required
              onChange={(value) => {
                if (when.kind === "condition") {
                  setWhen({ ...when, property: value });
                } else {
                  setWhen({ ...when, property: value, colors: [] });
                }
              }}
            />
            <datalist id={keysId}>
              {keys.map((key) => (
                <option key={key} value={key} />
              ))}
            </datalist>
          </>
        )}
        {when.kind === "condition" ? <ConditionFields condition={when} onChange={setWhen} /> : null}
        {when.kind === "values" && report !== undefined && report.values !== null ? (
          <ValueTable
            kind={kind}
            when={when}
            report={report.values}
            number={number}
            onChange={setWhen}
          />
        ) : null}
      </fieldset>
      <fieldset className="graph-style-form__group">
        <legend className="field__label">{t("graphStyle.form.then")}</legend>
        {when.kind === "values" ? (
          <p className="field__hint">{t("graphStyle.form.colorPerValue")}</p>
        ) : null}
        {targetList
          .filter((key) => set[key] !== undefined)
          .map((key) => (
            <TargetField
              key={key}
              target={key}
              value={set[key]}
              onChange={(value) => setTarget(key, value)}
            />
          ))}
        {status ? (
          <p className="field__hint" role="note">
            {t("graphStyle.form.secondCue")}
          </p>
        ) : null}
        {free.length > 0 ? (
          <div className="field">
            <label className="visually-hidden" htmlFor={targetId}>
              {t("graphStyle.form.addTarget")}
            </label>
            <Select
              id={targetId}
              value=""
              onChange={(key) => {
                if (key !== "") setTarget(key as TargetKey, defaultOf(key as TargetKey));
              }}
            >
              <option value="">{t("graphStyle.form.addTarget")}</option>
              {free.map((key) => (
                <option key={key} value={key}>
                  {t(`graphStyle.target.${key}` as MessageKey)}
                </option>
              ))}
            </Select>
          </div>
        ) : null}
      </fieldset>
      <div className="graph-style-form__actions">
        <button
          type="button"
          className="button button--ghost button--small"
          disabled={onDuplicate === null}
          onClick={() => onDuplicate?.()}
        >
          <Icon name="copy" />
          {t("graphStyle.rule.duplicate")}
        </button>
        <button type="button" className="button button--ghost button--small" onClick={onRemove}>
          <Icon name="trash" />
          {t("graphStyle.rule.delete")}
        </button>
        <button type="button" className="button button--secondary button--small" onClick={onDone}>
          {t("graphStyle.rule.done")}
        </button>
      </div>
    </section>
  );
}

function defaultOf(key: TargetKey): unknown {
  switch (key) {
    case "color":
      return "chart-1";
    case "size":
      return RULE_SIZE.default;
    case "sizeBy":
      return { property: "", min: 5, max: 17 };
    case "colorBy":
      return { property: "", color: "chart-1" };
    case "width":
      return RULE_WIDTH.default;
    case "shape":
      return "diamond";
    case "icon":
      return "user";
    case "border":
      return "dashed";
    case "dash":
      return "dashed";
    case "arrow":
      return "direction";
    case "badge":
      return "!";
    default:
      return "{name}";
  }
}

function TextField({
  label,
  value,
  hint,
  error,
  list,
  mono = false,
  maxLength = MAX_RULE_TEXT,
  inputMode,
  required = false,
  onChange,
}: {
  label: string;
  value: string;
  /** An empty field keeps the last value (a rule's property is never empty). */
  required?: boolean;
  hint?: string | undefined;
  error?: string | null | undefined;
  list?: string | undefined;
  mono?: boolean;
  maxLength?: number;
  inputMode?: "decimal" | "numeric" | "text" | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState(value);
  // A value changed from outside (another rule, a copy) replaces what was typed.
  const [last, setLast] = useState(value);
  if (last !== value) {
    setLast(value);
    if (!(required && text.trim() === "" && value !== "")) setText(value);
  }
  const described = [hint === undefined ? null : `${id}-hint`, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ");
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
        className={mono ? "input input--mono" : "input"}
        value={text}
        list={list}
        maxLength={maxLength}
        inputMode={inputMode}
        aria-invalid={error ? true : undefined}
        aria-describedby={described === "" ? undefined : described}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setText(next);
          if (!required || next.trim() !== "") onChange(next);
        }}
      />
      {error ? (
        <p className="field__error" id={`${id}-error`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

function ConditionFields({
  condition,
  onChange,
}: {
  condition: Condition;
  onChange: (condition: Condition) => void;
}) {
  const { t } = useI18n();
  const typeId = useId();
  const opId = useId();
  const count = operands(condition.op);
  const problem = conditionProblem(condition);
  const errorText = (): string => {
    if (condition.type === "number") {
      return t("graphStyle.error.number", { property: condition.property });
    }
    if (condition.type === "date") {
      return t(condition.op === "lastDays" ? "graphStyle.error.days" : "graphStyle.error.date");
    }
    return t("graphStyle.error.text");
  };
  const numeric = condition.type === "number" || condition.op === "lastDays";
  return (
    <>
      <div className="graph-style-form__pair">
        <div className="field">
          <label className="field__label" htmlFor={typeId}>
            {t("graphStyle.form.type")}
          </label>
          <Select
            id={typeId}
            value={condition.type}
            onChange={(next) => {
              const type = next as ValueType;
              const ops = CONDITION_OPS[type] as readonly ConditionOp[];
              const op = ops.includes(condition.op) ? condition.op : (ops[0] as ConditionOp);
              onChange({ ...condition, type, op });
            }}
          >
            {VALUE_TYPES.map((type) => (
              <option key={type} value={type}>
                {t(`graphStyle.type.${type}`)}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={opId}>
            {t("graphStyle.form.op")}
          </label>
          <Select
            id={opId}
            value={condition.op}
            onChange={(op) => onChange({ ...condition, op: op as ConditionOp })}
          >
            {(CONDITION_OPS[condition.type] as readonly ConditionOp[]).map((op) => (
              <option key={op} value={op}>
                {opText(t, condition.type, op)}
              </option>
            ))}
          </Select>
        </div>
      </div>
      {count >= 1 ? (
        <div className="graph-style-form__pair">
          <TextField
            label={t(
              condition.op === "lastDays" ? "graphStyle.form.days" : "graphStyle.form.value",
            )}
            hint={
              condition.type === "date" && condition.op !== "lastDays"
                ? t("graphStyle.form.dateHint")
                : undefined
            }
            value={condition.value}
            inputMode={numeric ? "decimal" : undefined}
            error={problem === "value" && condition.value !== "" ? errorText() : null}
            onChange={(value) => onChange({ ...condition, value })}
          />
          {count === 2 ? (
            <TextField
              label={t("graphStyle.form.to")}
              value={condition.to}
              inputMode={numeric ? "decimal" : undefined}
              error={problem === "to" && condition.to !== "" ? errorText() : null}
              onChange={(to) => onChange({ ...condition, to })}
            />
          ) : null}
        </div>
      ) : null}
      {condition.type === "text" && count > 0 ? (
        <label className="checkbox">
          <input
            type="checkbox"
            checked={condition.caseSensitive}
            onChange={(event) =>
              onChange({ ...condition, caseSensitive: event.currentTarget.checked })
            }
          />
          {t("graphStyle.form.caseSensitive")}
        </label>
      ) : null}
      {condition.type !== "boolean" ? (
        <p className="field__hint">{t("graphStyle.form.listHint")}</p>
      ) : null}
    </>
  );
}

/** The values of a rule "per unique value": N of M with a color each, "other" and "without". */
function ValueTable({
  kind,
  when,
  report,
  number,
  onChange,
}: {
  kind: Kind;
  when: Extract<RuleWhen, { kind: "values" }>;
  report: NonNullable<Evaluation["rules"][number]["values"]>;
  number: Intl.NumberFormat;
  onChange: (when: RuleWhen) => void;
}) {
  const { t } = useI18n();
  const pin = (value: string, color: StyleColor) => {
    // The values up to the changed one (and up to the last one already given a color) keep the
    // colors they have now, so changing one color moves no other value.
    const at = report.shown.findIndex((slot) => slot.value === value);
    const last = report.shown.reduce(
      (max, slot, i) => (when.colors.some((c) => c.value === slot.value) ? i : max),
      -1,
    );
    const colors = report.shown.slice(0, Math.max(at, last) + 1).map((slot) => ({
      value: slot.value,
      color: slot.value === value ? color : slot.color,
    }));
    onChange({ ...when, colors });
  };
  return (
    <div className="graph-style-values">
      <p className="graph-style-values__count">
        {t("graphStyle.values.count", {
          shown: number.format(report.shown.filter((slot) => slot.count > 0).length),
          total: number.format(report.total),
        })}
      </p>
      <table className="graph-style-values__table">
        <thead>
          <tr>
            <th scope="col">{t("graphStyle.values.value")}</th>
            <th scope="col">{t(`graphStyle.kind.${kind}`)}</th>
            <th scope="col">{t("graphStyle.target.color")}</th>
          </tr>
        </thead>
        <tbody>
          {report.shown.map((slot) => (
            <tr key={slot.value}>
              <th scope="row" className="truncate" title={slot.value}>
                {slot.value}
              </th>
              <td className="graph-style-values__number">{number.format(slot.count)}</td>
              <td>
                <ColorChoice
                  label={t("graphStyle.values.change", { value: slot.value })}
                  value={slot.color}
                  kind={kind}
                  shifted={slot.shifted}
                  onChange={(color) => pin(slot.value, color)}
                />
              </td>
            </tr>
          ))}
          {report.other.values > 0 ? (
            <tr>
              <th scope="row">
                {t("graphStyle.values.other", { count: number.format(report.other.values) })}
              </th>
              <td className="graph-style-values__number">{number.format(report.other.count)}</td>
              <td>{t("graphStyle.color.neutral")}</td>
            </tr>
          ) : null}
          {report.missing > 0 ? (
            <tr>
              <th scope="row">{t("graphStyle.values.missing")}</th>
              <td className="graph-style-values__number">{number.format(report.missing)}</td>
              <td>{t("graphStyle.values.basis")}</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p className="field__hint">{t("graphStyle.values.hint")}</p>
    </div>
  );
}

/** A compact color choice: a select of the rule colors, each named, with its swatch. */
function ColorChoice({
  label,
  value,
  kind,
  shifted = false,
  onChange,
}: {
  label: string;
  value: StyleColor;
  kind: Kind;
  shifted?: boolean;
  onChange: (color: StyleColor) => void;
}) {
  const { t } = useI18n();
  return (
    <span className="graph-style-color">
      {kind === "nodes" ? (
        <NodeSwatch
          color={value}
          shape={shifted ? (shiftedShape("circle") as RuleShape) : "circle"}
        />
      ) : (
        <EdgeSwatch color={value} dash={shifted ? SHIFTED_DASH : "solid"} />
      )}
      <Select
        aria-label={label}
        className="graph-style-color__select"
        value={value}
        onChange={(next) => onChange(next as StyleColor)}
      >
        {STYLE_COLORS.map((color) => (
          <option key={color} value={color}>
            {t(`graphStyle.color.${color}`)}
          </option>
        ))}
      </Select>
    </span>
  );
}

/** One target of the open rule with its control and a button that takes it out. */
function TargetField({
  target,
  value,
  onChange,
}: {
  target: TargetKey;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const { t } = useI18n();
  const name = t(`graphStyle.target.${target}` as MessageKey);
  const remove = (
    <IconButton
      icon="close"
      label={t("graphStyle.form.removeTarget", { target: name })}
      onClick={() => onChange(undefined)}
    />
  );
  let control: ReactNode;
  switch (target) {
    case "color":
      control = <ColorPalette label={name} value={value as StyleColor} onChange={onChange} />;
      break;
    case "size":
    case "width": {
      const bounds = target === "size" ? RULE_SIZE : RULE_WIDTH;
      control = (
        <RangeField
          label={name}
          value={value as number}
          min={bounds.min}
          max={bounds.max}
          onChange={onChange}
        />
      );
      break;
    }
    case "colorBy": {
      const by = value as { property: string; color: StyleColor };
      control = (
        <fieldset className="graph-style-size-by">
          <legend className="field__label">{name}</legend>
          <TextField
            label={t("graphStyle.sizeBy.property")}
            value={by.property}
            mono
            onChange={(property) => onChange({ ...by, property })}
          />
          <ColorPalette
            label={t("graphStyle.colorBy.tone")}
            value={by.color}
            onChange={(color) => onChange({ ...by, color })}
          />
          <p className="field__hint">{t("graphStyle.colorBy.hint")}</p>
        </fieldset>
      );
      break;
    }
    case "sizeBy": {
      const by = value as { property: string; min: number; max: number };
      control = (
        <fieldset className="graph-style-size-by">
          <legend className="field__label">{name}</legend>
          <TextField
            label={t("graphStyle.sizeBy.property")}
            value={by.property}
            mono
            onChange={(property) => onChange({ ...by, property })}
          />
          <RangeField
            label={t("graphStyle.sizeBy.min")}
            value={by.min}
            min={RULE_SIZE.min}
            max={RULE_SIZE.max}
            onChange={(min) => onChange({ ...by, min, max: Math.max(min, by.max) })}
          />
          <RangeField
            label={t("graphStyle.sizeBy.max")}
            value={by.max}
            min={RULE_SIZE.min}
            max={RULE_SIZE.max}
            onChange={(max) => onChange({ ...by, max, min: Math.min(max, by.min) })}
          />
          <p className="field__hint">{t("graphStyle.sizeBy.hint")}</p>
        </fieldset>
      );
      break;
    }
    case "shape":
      control = (
        <ChoiceRow
          label={name}
          value={value as string}
          choices={RULE_SHAPES}
          text={(shape) => t(`graphStyle.shape.${shape}` as MessageKey)}
          swatch={(shape) => <NodeSwatch shape={shape as (typeof RULE_SHAPES)[number]} />}
          onChange={onChange}
        />
      );
      break;
    case "border":
      control = (
        <ChoiceRow
          label={name}
          value={value as string}
          choices={RULE_BORDERS}
          text={(border) => t(`graphStyle.border.${border}` as MessageKey)}
          swatch={(border) => (
            <NodeSwatch color="neutral" border={border as (typeof RULE_BORDERS)[number]} />
          )}
          onChange={onChange}
        />
      );
      break;
    case "dash":
      control = (
        <ChoiceRow
          label={name}
          value={value as string}
          choices={EDGE_DASHES}
          text={(dash) => t(`graphStyle.dash.${dash}` as MessageKey)}
          swatch={(dash) => <EdgeSwatch dash={dash as (typeof EDGE_DASHES)[number]} />}
          onChange={onChange}
        />
      );
      break;
    case "arrow":
      control = (
        <ChoiceRow
          label={name}
          value={value as string}
          choices={EDGE_ARROWS}
          text={(arrow) => t(`graphStyle.arrow.${arrow}` as MessageKey)}
          onChange={onChange}
        />
      );
      break;
    case "icon":
      control = <IconPicker label={name} value={value as string} onChange={onChange} />;
      break;
    case "badge":
      control = (
        <TextField
          label={name}
          hint={t("graphStyle.form.badgeHint", { example: "{name}", max: MAX_BADGE_CHARS })}
          value={value as string}
          required
          onChange={onChange}
        />
      );
      break;
    default:
      control = (
        <TextField
          label={name}
          hint={t("graphStyle.form.labelHint", { example: "{name}" })}
          value={value as string}
          required
          onChange={onChange}
        />
      );
  }
  return (
    <div className="graph-style-target">
      <div className="graph-style-target__control">{control}</div>
      {remove}
    </div>
  );
}

/** The rule colors as a group of radio buttons; the chosen one carries a check. */
function ColorPalette({
  label,
  value,
  onChange,
}: {
  label: string;
  value: StyleColor;
  onChange: (color: StyleColor) => void;
}) {
  const { t } = useI18n();
  const name = useId();
  return (
    <fieldset className="graph-style-palette">
      <legend className="field__label">{label}</legend>
      <div className="graph-style-palette__colors">
        {STYLE_COLORS.map((color) => (
          <label
            key={color}
            className="graph-style-palette__color"
            title={t(`graphStyle.color.${color}`)}
          >
            <input
              type="radio"
              name={name}
              className="visually-hidden"
              checked={value === color}
              onChange={() => onChange(color)}
            />
            <NodeSwatch color={color} />
            {value === color ? <Icon name="check" className="graph-style-palette__check" /> : null}
            <span className="visually-hidden">{t(`graphStyle.color.${color}`)}</span>
          </label>
        ))}
      </div>
    </fieldset>
  );
}

function ChoiceRow({
  label,
  value,
  choices,
  text,
  swatch,
  onChange,
}: {
  label: string;
  value: string;
  choices: readonly string[];
  text: (choice: string) => string;
  swatch?: (choice: string) => ReactNode;
  onChange: (value: string) => void;
}) {
  return (
    <fieldset className="graph-style-choices">
      <legend className="field__label">{label}</legend>
      {/* biome-ignore lint/a11y/useSemanticElements: toggle buttons inside the field set */}
      <div className="graph__segmented" role="group" aria-label={label}>
        {choices.map((choice) => (
          <button
            key={choice}
            type="button"
            className="graph__segment"
            aria-pressed={value === choice}
            onClick={() => onChange(choice)}
          >
            {swatch?.(choice)}
            {text(choice)}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

function RangeField({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <div className="graph-style-range">
        <input
          id={id}
          type="range"
          min={min}
          max={max}
          step={1}
          value={value}
          onChange={(event) => onChange(Number(event.currentTarget.value))}
        />
        <output htmlFor={id}>{value}</output>
      </div>
    </div>
  );
}
