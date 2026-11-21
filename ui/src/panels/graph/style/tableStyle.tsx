import type { Frame } from "../../../api/generated/shapes";
import { useI18n } from "../../../i18n/i18n";
import { colorText } from "./describe";
import { evaluateRules, type StyleItem } from "./evaluate";
import { IconGlyph, NodeSwatch } from "./Swatch";
import { type GraphStyle, readableStyle, type StyleColor } from "./schema";
import "./style.css";

/**
 * Style rules on a table made from a graph (Graph081 board, frame 11): the rows are the graph's
 * nodes (with `@labels`) or edges (with `@type`), the columns their properties. A color shows as
 * a dot before the value of the property that decides it, icon and badge stand at the caption,
 * and a label rule replaces the caption's text. Size, shape and frame have no place in a table;
 * an edge table takes only the color. The table panel loads this module only for a panel with
 * rules, so ordinary tables carry none of it.
 */

/** What the rules give one cell. */
export interface CellLook {
  dot?: StyleColor;
  icon?: string;
  badge?: string;
  text?: string;
}

export interface TableLooks {
  /** Per row (the frame's row index), per column index: what the rules give the cell. */
  cells: (Map<number, CellLook> | undefined)[];
  /** Columns whose color a rule decides, with the first rule (from 1) doing so. */
  colored: Map<number, number>;
}

const CAPTION_NAMES = ["name", "title", "caption", "label", "displayName"];

/** The column a label, icon or badge stands at: a name-like one, else the first property. */
export function captionColumn(frame: Frame): number {
  const names = frame.fields.map((field) => field.name);
  for (const wanted of CAPTION_NAMES) {
    const at = names.indexOf(wanted);
    if (at >= 0) return at;
  }
  const first = names.findIndex((name) => !name.startsWith("@"));
  return Math.max(first, 0);
}

function kindsOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string" && value !== "") {
    if (value.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(value);
        if (Array.isArray(parsed)) return parsed.map(String);
      } catch {
        // Not a list after all: the text is the one label.
      }
    }
    return [value];
  }
  return [];
}

/** The looks of a frame's rows, or null where no rule applies. */
export function tableLooks(frame: Frame, style: GraphStyle, now?: number): TableLooks | null {
  const fields = frame.fields;
  // Only a table made from a graph: its rows carry their labels (`@labels`) or type (`@type`).
  const edges = fields.some((field) => field.name === "@type");
  if (!edges && !fields.some((field) => field.name === "@labels")) return null;
  const readable = readableStyle(style);
  const rules = edges ? readable.edges : readable.nodes;
  if (rules.length === 0) return null;
  const kindField = fields.find((field) => field.name === (edges ? "@type" : "@labels"));
  const rows = fields[0]?.values.length ?? 0;
  const items: StyleItem[] = [];
  for (let row = 0; row < rows; row++) {
    const properties: Record<string, unknown> = {};
    for (const field of fields) {
      if (!field.name.startsWith("@")) properties[field.name] = field.values[row];
    }
    items.push({ kinds: kindsOf(kindField?.values[row]), properties });
  }
  const evaluation = evaluateRules(rules, items, now === undefined ? {} : { now });
  const caption = captionColumn(frame);
  const column = (name: string | null) => {
    if (name === null) return caption;
    const at = fields.findIndex((field) => field.name === name);
    return at >= 0 ? at : caption;
  };
  const colored = new Map<number, number>();
  const cells = evaluation.styles.map((itemStyle) => {
    if (itemStyle === null) return undefined;
    const looks = new Map<number, CellLook>();
    const at = (index: number) => {
      const known = looks.get(index);
      if (known !== undefined) return known;
      const look: CellLook = {};
      looks.set(index, look);
      return look;
    };
    const { set, from } = itemStyle;
    if (set.color !== undefined && from.color !== undefined) {
      const when = rules[from.color]?.when;
      const index = column(when === undefined || when.kind === "always" ? null : when.property);
      at(index).dot = set.color;
      if (!colored.has(index)) colored.set(index, from.color + 1);
    }
    if (!edges) {
      if (set.icon !== undefined) at(caption).icon = set.icon;
      if (set.badge !== undefined) at(caption).badge = set.badge;
      if (set.label !== undefined) at(caption).text = set.label;
    }
    return looks.size === 0 ? undefined : looks;
  });
  return { cells, colored };
}

/**
 * A cell's content with what the rules give it: the color as a dot (named for screen readers
 * and with forced colors, where the dot loses its color), the icon before the text, the badge
 * after it.
 */
export function RuleCell({ look, text }: { look: CellLook; text: string }) {
  const { t } = useI18n();
  return (
    <span className="graph-style-cell">
      {look.dot === undefined ? null : (
        <span className="graph-style-cell__dot" title={colorText(t, look.dot)}>
          <NodeSwatch color={look.dot} />
          <span className="visually-hidden">{`${colorText(t, look.dot)}: `}</span>
        </span>
      )}
      {look.icon === undefined ? null : <IconGlyph name={look.icon} />}
      <span className="truncate">{look.text ?? text}</span>
      {look.badge === undefined ? null : <span className="graph-style__badge">{look.badge}</span>}
    </span>
  );
}

/** Says at a column that a rule's color applies before the column's own colors. */
export function RuleWinsNote({ column, rule }: { column: string; rule: number }) {
  const { t } = useI18n();
  return <p className="panel-note">{t("graphStyle.table.ruleWins", { column, rule })}</p>;
}
