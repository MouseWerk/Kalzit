import {
  type KeyboardEvent,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../components/Icon";
import { placeMenu } from "../../components/menuPlacement";
import { isInsideSelectPopup, Select } from "../../components/Select";
import { useI18n } from "../../i18n/i18n";
import { useEscapeLayer } from "../../lib/layers";
import {
  type AdhocFilter,
  decodeFilters,
  encodeFilter,
  type FilterOperator,
  MAX_FILTER_KEY,
  MAX_FILTER_VALUE,
  operatorKey,
} from "./adhoc";
import "./toolbar.css";

/** Which part of a filter the editor opens at: the field, the comparison or the value. */
type Part = "key" | "operator" | "value";

/** What the editor is open for: a new filter, or the filter at `index`. */
type Editing = { index: number | null; part: Part; anchor: HTMLElement };

/**
 * The chips of an ad hoc variable in the bar (board ParityEditors, frame 10): field, comparison
 * and value in one quiet surface, the value in bold; a click on one part opens the editor at that
 * part, and each chip has its own remove button. "Add filter" opens the editor for a new one.
 * `operators` are those the variable's source can apply; `room` is how many filters the
 * dashboard may still take (the server allows 20 over all ad hoc variables).
 */
export function AdhocFilters({
  label,
  value,
  operators,
  room,
  onChange,
}: {
  label: string;
  /** The filters as the bar keeps them (`encodeFilter`). */
  value: readonly string[];
  operators: readonly FilterOperator[];
  room: number;
  onChange: (value: string[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const filters = decodeFilters(value);
  const blocked =
    operators.length === 0
      ? t("dashboards.filters.unsupported")
      : room <= 0
        ? t("dashboards.filters.full")
        : null;
  const [editing, setEditing] = useState<Editing | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const opName = (operator: FilterOperator) =>
    t(`dashboards.filters.operator.${operatorKey(operator)}`);
  const chipText = (filter: AdhocFilter) =>
    t("dashboards.filters.chip", {
      key: filter.key,
      operator: opName(filter.operator),
      value: filter.value,
    });

  const save = (filter: AdhocFilter) => {
    const next = [...filters];
    if (editing?.index === null || editing === null) next.push(filter);
    else next[editing.index] = filter;
    onChange(next.map(encodeFilter));
  };
  const remove = (index: number) => {
    onChange(filters.filter((_, i) => i !== index).map(encodeFilter));
    // Focus moves on to the next chip's remove button, or to "Add filter" after the last one.
    requestAnimationFrame(() => {
      const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>("[data-remove]");
      const next = buttons?.[Math.min(index, (buttons?.length ?? 1) - 1)];
      (next ?? addRef.current)?.focus();
    });
  };
  const open = (index: number | null, part: Part, anchor: HTMLElement) =>
    setEditing({ index, part, anchor });

  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of chips and a button, not a field set
    <div className="variables__item variables__filters" role="group" aria-label={label}>
      <span className="variables__label">{label}</span>
      {filters.length === 0 ? null : (
        <ul className="filter-chips" ref={listRef} aria-label={label}>
          {filters.map((filter, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: filters have no id; equal ones may repeat
            <li key={index} className="filter-chip">
              <button
                type="button"
                className="filter-chip__part"
                aria-label={t("dashboards.filters.editKey", { filter: chipText(filter) })}
                onClick={(event) => open(index, "key", event.currentTarget)}
              >
                {filter.key}
              </button>
              <button
                type="button"
                className="filter-chip__part filter-chip__operator"
                aria-label={t("dashboards.filters.editOperator", { filter: chipText(filter) })}
                title={opName(filter.operator)}
                onClick={(event) => open(index, "operator", event.currentTarget)}
              >
                {operatorSign(filter.operator)}
              </button>
              <button
                type="button"
                className="filter-chip__part filter-chip__value"
                aria-label={t("dashboards.filters.editValue", { filter: chipText(filter) })}
                onClick={(event) => open(index, "value", event.currentTarget)}
              >
                {filter.value === "" ? t("dashboards.filters.empty") : filter.value}
              </button>
              <button
                type="button"
                className="filter-chip__remove"
                data-remove=""
                aria-label={t("dashboards.filters.remove", { filter: chipText(filter) })}
                onClick={() => remove(index)}
              >
                <Icon name="close" size="small" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        ref={addRef}
        type="button"
        className="filter-chips__add"
        aria-disabled={blocked !== null}
        aria-describedby={blocked === null ? undefined : `${id}-blocked`}
        title={blocked ?? undefined}
        onClick={(event) => {
          if (blocked === null) open(null, "key", event.currentTarget);
        }}
      >
        <Icon name="plus" size="small" />
        {filters.length === 0 ? (
          <span>{t("dashboards.filters.add")}</span>
        ) : (
          <span className="visually-hidden">{t("dashboards.filters.add")}</span>
        )}
      </button>
      {blocked === null ? null : (
        <span id={`${id}-blocked`} className="visually-hidden">
          {blocked}
        </span>
      )}
      {editing === null ? null : (
        <FilterEditor
          label={label}
          start={editing.index === null ? undefined : filters[editing.index]}
          part={editing.part}
          anchor={editing.anchor}
          operators={operators}
          onSave={(filter) => {
            save(filter);
            setEditing(null);
            requestAnimationFrame(() =>
              (editing.anchor.isConnected ? editing.anchor : addRef.current)?.focus(),
            );
          }}
          onClose={() => {
            setEditing(null);
            editing.anchor.focus();
          }}
        />
      )}
    </div>
  );
}

/** The comparison as a short sign on the chip. */
export function operatorSign(operator: FilterOperator): string {
  switch (operator) {
    case "!=":
      return "≠";
    default:
      return operator;
  }
}

/**
 * A small popup next to the part that was clicked: field, comparison and value, then Apply.
 * Enter applies, Escape closes without a change; the part that was clicked has the focus.
 */
function FilterEditor({
  label,
  start,
  part,
  anchor,
  operators,
  onSave,
  onClose,
}: {
  label: string;
  start: AdhocFilter | undefined;
  part: Part;
  anchor: HTMLElement;
  operators: readonly FilterOperator[];
  onSave: (filter: AdhocFilter) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const [key, setKey] = useState(start?.key ?? "");
  const [operator, setOperator] = useState<FilterOperator>(
    start?.operator !== undefined && operators.includes(start.operator)
      ? start.operator
      : (operators[0] ?? "="),
  );
  const [value, setValue] = useState(start?.value ?? "");
  const [tried, setTried] = useState(false);
  useEscapeLayer(true, onClose);

  useLayoutEffect(() => {
    if (boxRef.current !== null) placeMenu(anchor, boxRef.current);
    boxRef.current?.querySelector<HTMLElement>(`[data-part="${part}"]`)?.focus();
  }, [anchor, part]);

  const outside = useEffectEvent((event: PointerEvent) => {
    // The comparison's list is drawn at the end of the page; a pick in it is the editor's.
    if (
      event.target instanceof Node &&
      boxRef.current?.contains(event.target) !== true &&
      !isInsideSelectPopup(event.target)
    ) {
      onClose();
    }
  });
  useEffect(() => {
    const listener = (event: PointerEvent) => outside(event);
    document.addEventListener("pointerdown", listener, true);
    return () => document.removeEventListener("pointerdown", listener, true);
  }, []);

  const keyError =
    key.trim() === ""
      ? t("dashboards.filters.keyRequired")
      : key.length > MAX_FILTER_KEY
        ? t("dashboards.filters.keyTooLong", { max: MAX_FILTER_KEY })
        : null;
  const valueError =
    value.length > MAX_FILTER_VALUE
      ? t("dashboards.filters.valueTooLong", { max: MAX_FILTER_VALUE })
      : null;

  const apply = () => {
    setTried(true);
    if (keyError !== null || valueError !== null) return;
    onSave({ key: key.trim(), operator, value });
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      const target = event.target as HTMLElement;
      if (target.tagName === "INPUT") {
        event.preventDefault();
        apply();
      }
    }
  };

  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={
        start === undefined
          ? t("dashboards.filters.addTitle", { label })
          : t("dashboards.filters.editTitle", { label })
      }
      className="menu variables__menu filter-editor"
      onKeyDown={onKeyDown}
    >
      <div className="filter-editor__fields">
        <div className="field">
          <label className="field__label" htmlFor={`${id}-key`}>
            {t("dashboards.filters.key")}
          </label>
          <input
            id={`${id}-key`}
            data-part="key"
            className="input"
            value={key}
            maxLength={MAX_FILTER_KEY + 1}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tried && keyError !== null}
            aria-describedby={tried && keyError !== null ? `${id}-key-error` : undefined}
            onChange={(event) => setKey(event.currentTarget.value)}
          />
          {tried && keyError !== null ? (
            <p className="field__error" id={`${id}-key-error`}>
              {keyError}
            </p>
          ) : null}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-op`}>
            {t("dashboards.filters.operator")}
          </label>
          <Select
            id={`${id}-op`}
            data-part="operator"
            value={operator}
            onChange={(next) => setOperator(next as FilterOperator)}
          >
            {operators.map((o) => (
              <option key={o} value={o}>
                {`${operatorSign(o)}  ${t(`dashboards.filters.operator.${operatorKey(o)}`)}`}
              </option>
            ))}
          </Select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={`${id}-value`}>
            {t("dashboards.filters.value")}
          </label>
          <input
            id={`${id}-value`}
            data-part="value"
            className="input"
            value={value}
            autoComplete="off"
            spellCheck={false}
            aria-invalid={tried && valueError !== null}
            aria-describedby={tried && valueError !== null ? `${id}-value-error` : undefined}
            onChange={(event) => setValue(event.currentTarget.value)}
          />
          {tried && valueError !== null ? (
            <p className="field__error" id={`${id}-value-error`}>
              {valueError}
            </p>
          ) : null}
        </div>
      </div>
      <div className="filter-editor__actions">
        <button type="button" className="button button--secondary button--small" onClick={onClose}>
          {t("dashboards.filters.cancel")}
        </button>
        <button type="button" className="button button--primary button--small" onClick={apply}>
          {t("dashboards.filters.apply")}
        </button>
      </div>
    </div>,
    document.body,
  );
}
