import {
  type ButtonHTMLAttributes,
  Children,
  Fragment,
  isValidElement,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../i18n/i18n";
import { isComposingKey } from "../lib/ime";
import { useEscapeLayer } from "../lib/layers";
import { Icon } from "./Icon";
import "./select.css";

/** One entry of the list, read from an `<option>` child. */
export interface SelectOption {
  value: string;
  label: string;
  disabled: boolean;
  /** A placeholder that shows while selected but is not offered in the list. */
  hidden: boolean;
  /** The label of the `<optgroup>` around it. */
  group: string | undefined;
}

/** From this many options on, the list gets a search field (unless `searchable` says otherwise). */
const SEARCH_FROM = 12;
/** Up to this many options size the closed control to the longest one, as a native select does. */
const SIZER_MAX = 50;
/** Type-ahead keys typed within this time form one search. */
const TYPEAHEAD_MS = 500;
/** Keys that move the active option by a page. */
const PAGE_STEP = 10;
/** The gap between the list and the control, and between the list and the window's edge. */
const GAP_PX = 4;
const EDGE_PX = 8;

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === "boolean") {
    return "";
  }
  if (typeof node === "string" || typeof node === "number" || typeof node === "bigint") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map(textOf).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return textOf(node.props.children);
  }
  return "";
}

interface OptionProps {
  value?: string | number;
  label?: string;
  disabled?: boolean;
  hidden?: boolean;
  children?: ReactNode;
}

function collect(children: ReactNode, group: string | undefined, out: SelectOption[]): void {
  Children.forEach(children, (child) => {
    if (!isValidElement<OptionProps>(child)) {
      return;
    }
    if (child.type === Fragment) {
      collect(child.props.children, group, out);
    } else if (child.type === "optgroup") {
      collect(child.props.children, child.props.label, out);
    } else if (child.type === "option") {
      const label = textOf(child.props.children) || (child.props.label ?? "");
      out.push({
        value: child.props.value === undefined ? label : String(child.props.value),
        label,
        disabled: child.props.disabled === true,
        hidden: child.props.hidden === true,
        group,
      });
    }
  });
}

/**
 * Whether a node is inside an open select's list. The list is drawn at the end of the page, so
 * focus moving into its search field leaves the surrounding part of the page only in the DOM; a
 * handler that acts when focus leaves treats the list as still inside.
 */
export function isInsideSelectPopup(node: EventTarget | null): boolean {
  const element = node instanceof Element ? node : node instanceof Node ? node.parentElement : null;
  return element?.closest("[data-select-popup]") != null;
}

/** The options described by `<option>` and `<optgroup>` children, in order. */
export function readOptions(children: ReactNode): SelectOption[] {
  const out: SelectOption[] = [];
  collect(children, undefined, out);
  return out;
}

type ButtonProps = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  "onChange" | "value" | "children" | "type" | "defaultValue"
>;

export interface SelectProps extends ButtonProps {
  /** The chosen option's value; a number compares as its text, as with a native select. */
  value: string | number;
  onChange: (value: string) => void;
  /** `<option>` elements, optionally inside `<optgroup>`, as for a native select. */
  children: ReactNode;
  /** A search field above the list: on for long lists by default. */
  searchable?: boolean | undefined;
  /** Submits the value with a surrounding form under this name. */
  name?: string | undefined;
  ref?: Ref<HTMLButtonElement> | undefined;
}

/**
 * A select drawn by Kalzit, after the WAI-ARIA select-only combobox pattern: the control keeps
 * focus while the list is open (aria-activedescendant); arrows, Home, End, Page Up and Page Down
 * move, typed letters jump to a matching option, Enter and Space choose, Escape and Tab close.
 * Long lists get a search field. The control is a button, so labels (`htmlFor` or a wrapping
 * label), descriptions and error wiring work as with a native select. The list is drawn in the
 * window, under the control or above it near the bottom edge, so a narrow row never clips it.
 */
export function Select({
  value: rawValue,
  onChange,
  children,
  searchable,
  name,
  disabled,
  className,
  title,
  onKeyDown,
  onClick,
  ref,
  ...rest
}: SelectProps) {
  const { t } = useI18n();
  const value = String(rawValue);
  const options = readOptions(children);
  const listId = useId();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(-1);
  const [listLabel, setListLabel] = useState<string | undefined>(undefined);
  const typeahead = useRef({ text: "", at: 0 });

  const matchIndex = options.findIndex((option) => option.value === value);
  // A value without an option shows the first one that can be chosen, as a native select does.
  const shownIndex =
    matchIndex !== -1 ? matchIndex : options.findIndex((option) => !option.disabled);
  const shown = options[shownIndex];
  const withSearch = searchable ?? options.length >= SEARCH_FROM;
  const needle = query.trim().toLocaleLowerCase();
  // Indexes into `options` of what the list offers now.
  const visible = options.flatMap((option, index) =>
    option.hidden || (needle !== "" && !option.label.toLocaleLowerCase().includes(needle))
      ? []
      : [index],
  );
  const optionId = (index: number) => `${listId}-${index}`;

  function setTrigger(element: HTMLButtonElement | null) {
    triggerRef.current = element;
    if (typeof ref === "function") {
      ref(element);
    } else if (ref !== null && ref !== undefined) {
      ref.current = element;
    }
  }

  function openList(start?: number) {
    if (disabled === true) {
      return;
    }
    const trigger = triggerRef.current;
    const labels =
      trigger?.labels === undefined || trigger.labels === null ? [] : [...trigger.labels];
    setListLabel(
      rest["aria-label"] ?? (labels.map((label) => label.textContent ?? "").join(" ") || undefined),
    );
    setQuery("");
    setActive(start ?? (matchIndex === -1 ? (visibleFirst() ?? -1) : matchIndex));
    setOpen(true);
  }

  function visibleFirst(): number | undefined {
    return options.findIndex((option) => !option.hidden && !option.disabled);
  }

  function closeList(focusTrigger: boolean) {
    // Focus in the search field would fall to the page when the list goes (a click outside, a
    // scroll), out of a dialog that keeps it; it goes back to the control instead.
    const inList =
      document.activeElement !== null &&
      popupRef.current?.contains(document.activeElement) === true;
    setOpen(false);
    setQuery("");
    if (focusTrigger || inList) {
      triggerRef.current?.focus();
    }
  }

  function choose(index: number) {
    const option = options[index];
    if (option === undefined || option.disabled) {
      return;
    }
    closeList(true);
    if (option.value !== value) {
      onChange(option.value);
    }
  }

  /** The next option that can be chosen from `from` in `direction`, within what the list shows. */
  function step(from: number, direction: 1 | -1, count = 1): number {
    const enabled = visible.filter((index) => options[index]?.disabled !== true);
    if (enabled.length === 0) {
      return -1;
    }
    const at = enabled.indexOf(from);
    if (at === -1) {
      return direction === 1 ? (enabled[0] ?? -1) : (enabled.at(-1) ?? -1);
    }
    const next = Math.min(Math.max(at + direction * count, 0), enabled.length - 1);
    return enabled[next] ?? -1;
  }

  function edge(last: boolean): number {
    const enabled = visible.filter((index) => options[index]?.disabled !== true);
    return (last ? enabled.at(-1) : enabled[0]) ?? -1;
  }

  /** Type-ahead: the next option whose label starts with what was typed. */
  function findTyped(key: string, from: number): number {
    const now = Date.now();
    const state = typeahead.current;
    state.text = now - state.at > TYPEAHEAD_MS ? key : state.text + key;
    state.at = now;
    const text = state.text.toLocaleLowerCase();
    // The same letter again cycles through the options that start with it.
    const repeated = [...text].every((char) => char === text[0]);
    const prefix = repeated ? (text[0] ?? "") : text;
    const enabled = visible.filter((index) => options[index]?.disabled !== true);
    const start = enabled.indexOf(from);
    const order = [...enabled.slice(start + (repeated ? 1 : 0)), ...enabled.slice(0, start + 1)];
    return (
      order.find((index) => options[index]?.label.toLocaleLowerCase().startsWith(prefix)) ?? -1
    );
  }

  function onListKey(event: KeyboardEvent<HTMLElement>, inSearch: boolean): boolean {
    // A key that confirms an input method composition (in the search field) is left to it.
    if (isComposingKey(event)) {
      return false;
    }
    const key = event.key;
    if (key === "ArrowDown") {
      setActive(event.altKey ? active : step(active, 1));
    } else if (key === "ArrowUp") {
      if (event.altKey) {
        choose(active);
      } else {
        setActive(step(active, -1));
      }
    } else if (key === "PageDown") {
      setActive(step(active, 1, PAGE_STEP));
    } else if (key === "PageUp") {
      setActive(step(active, -1, PAGE_STEP));
    } else if ((key === "Home" || key === "End") && !inSearch) {
      setActive(edge(key === "End"));
    } else if (key === "Enter") {
      choose(active);
    } else if (key === " " && !inSearch && Date.now() - typeahead.current.at > TYPEAHEAD_MS) {
      choose(active);
    } else if (key === "Tab") {
      // Tab takes the active option, as the pattern says, and moves on; a surrounding dialog
      // still sees the key. From the search field (drawn at the end of the page) focus goes back
      // to the control first.
      const option = options[active];
      if (inSearch) {
        event.preventDefault();
      }
      closeList(inSearch);
      if (
        option !== undefined &&
        !option.disabled &&
        visible.includes(active) &&
        option.value !== value
      ) {
        onChange(option.value);
      }
      return false;
    } else if (!inSearch && key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = findTyped(key, active);
      if (found !== -1) {
        setActive(found);
      }
    } else {
      return false;
    }
    if (key !== "Tab") {
      event.preventDefault();
    }
    return true;
  }

  function onTriggerKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    onKeyDown?.(event);
    if (event.defaultPrevented || disabled === true || isComposingKey(event)) {
      return;
    }
    if (open) {
      if (onListKey(event, false)) {
        event.stopPropagation();
      }
      return;
    }
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp" || key === "Enter" || key === " ") {
      openList();
    } else if (key === "Home" || key === "End") {
      const enabled = options.flatMap((option, index) =>
        option.hidden || option.disabled ? [] : [index],
      );
      openList((key === "End" ? enabled.at(-1) : enabled[0]) ?? -1);
    } else if (key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      const found = findTyped(key, matchIndex);
      openList(found === -1 ? undefined : found);
    } else {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }

  useEscapeLayer(open, () => closeList(true));

  // Placed in the window next to the control: below, or above when there is more room there.
  // biome-ignore lint/correctness/useExhaustiveDependencies: placed again whenever the list's content changes
  useLayoutEffect(() => {
    const trigger = triggerRef.current;
    const popup = popupRef.current;
    if (!open || trigger === null || popup === null) {
      return;
    }
    const box = trigger.getBoundingClientRect();
    const viewWidth = document.documentElement.clientWidth || window.innerWidth;
    const viewHeight = document.documentElement.clientHeight || window.innerHeight;
    popup.style.setProperty("--select-min-width", `${box.width}px`);
    popup.style.setProperty("--select-max-height", "none");
    const natural = popup.scrollHeight;
    const below = viewHeight - box.bottom - GAP_PX - EDGE_PX;
    const above = box.top - GAP_PX - EDGE_PX;
    const down = natural <= below || below >= above;
    popup.style.setProperty("--select-max-height", `${Math.max(down ? below : above, 0)}px`);
    const height = Math.min(natural, down ? below : above);
    const top = down ? box.bottom + GAP_PX : box.top - GAP_PX - height;
    const width = popup.getBoundingClientRect().width;
    const left = Math.max(Math.min(box.left, viewWidth - width - EDGE_PX), EDGE_PX);
    popup.style.setProperty("--select-top", `${Math.max(top, EDGE_PX)}px`);
    popup.style.setProperty("--select-left", `${left}px`);
  }, [open, visible.length]);

  useEffect(() => {
    if (open && withSearch) {
      searchRef.current?.focus();
    }
  }, [open, withSearch]);

  // The active option stays in view while the keys move it.
  useEffect(() => {
    if (!open || active === -1) {
      return;
    }
    const element = document.getElementById(optionId(active));
    element?.scrollIntoView?.({ block: "nearest" });
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const inside = (target: EventTarget | null) =>
      target instanceof Node &&
      (popupRef.current?.contains(target) === true ||
        triggerRef.current?.contains(target) === true);
    const onPointerDown = (event: PointerEvent) => {
      if (!inside(event.target)) {
        closeList(false);
      }
    };
    const onScroll = (event: Event) => {
      if (!inside(event.target)) {
        closeList(false);
      }
    };
    const onResize = () => closeList(false);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
    };
  });

  const label = shown?.label ?? "";
  const activeId = open && active !== -1 && visible.includes(active) ? optionId(active) : undefined;

  function renderOption(index: number) {
    const option = options[index];
    if (option === undefined) {
      return null;
    }
    const selected = index === matchIndex;
    return (
      // biome-ignore lint/a11y/useFocusableInteractive: focus stays on the control (aria-activedescendant)
      // biome-ignore lint/a11y/useKeyWithClickEvents: the keys are handled on the control
      <div
        key={index}
        id={optionId(index)}
        role="option"
        aria-selected={selected}
        aria-disabled={option.disabled ? true : undefined}
        data-value={option.value}
        className={index === active ? "select-option select-option--active" : "select-option"}
        onPointerDown={(event) => event.preventDefault()}
        onPointerMove={() => {
          if (!option.disabled && active !== index) {
            setActive(index);
          }
        }}
        onClick={() => choose(index)}
      >
        <span className="select-option__check" aria-hidden="true">
          {selected ? <Icon name="check" /> : null}
        </span>
        <span className="select-option__label">{option.label}</span>
      </div>
    );
  }

  // Consecutive options of one group under one heading.
  const sections: { group: string | undefined; indexes: number[] }[] = [];
  for (const index of visible) {
    const group = options[index]?.group;
    const last = sections.at(-1);
    if (last !== undefined && last.group === group) {
      last.indexes.push(index);
    } else {
      sections.push({ group, indexes: [index] });
    }
  }

  const sizers =
    options.length <= SIZER_MAX
      ? options.filter((option, index) => index !== shownIndex && !option.hidden)
      : [];

  return (
    <>
      <button
        {...rest}
        ref={setTrigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && !withSearch ? activeId : undefined}
        value={shown?.value ?? ""}
        disabled={disabled}
        title={title ?? (label.length > 24 ? label : undefined)}
        className={className === undefined ? "select" : `select ${className}`}
        onClick={(event) => {
          onClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          if (open) {
            closeList(true);
          } else {
            openList();
          }
        }}
        onKeyDown={onTriggerKeyDown}
      >
        <span className="select__value">
          {sizers.map((option, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: labels may repeat; the order is fixed
            <span key={index} className="select__sizer" aria-hidden="true">
              {option.label}
            </span>
          ))}
          <span className="select__label">{label}</span>
        </span>
      </button>
      {name === undefined ? null : <input type="hidden" name={name} value={shown?.value ?? ""} />}
      {open
        ? createPortal(
            <div ref={popupRef} className="select-popup" data-select-popup="">
              {withSearch ? (
                <input
                  ref={searchRef}
                  type="text"
                  role="combobox"
                  className="input select-popup__search"
                  aria-label={t("common.select.search")}
                  aria-expanded="true"
                  aria-controls={listId}
                  aria-autocomplete="list"
                  aria-activedescendant={activeId}
                  autoComplete="off"
                  spellCheck={false}
                  value={query}
                  // A search typed here is not input a surrounding dialog has to keep.
                  onInput={(event) => event.stopPropagation()}
                  onChange={(event) => {
                    const next = event.currentTarget.value;
                    setQuery(next);
                    const lower = next.trim().toLocaleLowerCase();
                    const first = options.findIndex(
                      (option) =>
                        !option.hidden &&
                        !option.disabled &&
                        option.label.toLocaleLowerCase().includes(lower),
                    );
                    setActive(first);
                  }}
                  onKeyDown={(event) => {
                    if (onListKey(event, true)) {
                      event.stopPropagation();
                    }
                  }}
                />
              ) : null}
              <div
                id={listId}
                role="listbox"
                aria-label={rest["aria-labelledby"] === undefined ? listLabel : undefined}
                aria-labelledby={rest["aria-labelledby"]}
                tabIndex={-1}
                className="select-popup__list"
              >
                {sections.map((section, at) =>
                  section.group === undefined ? (
                    section.indexes.map(renderOption)
                  ) : (
                    // biome-ignore lint/suspicious/noArrayIndexKey: groups may repeat a label
                    // biome-ignore lint/a11y/useSemanticElements: a group of a listbox, not of a form
                    <div key={`group-${at}`} role="group" aria-labelledby={`${listId}-g${at}`}>
                      <div id={`${listId}-g${at}`} className="select-popup__group">
                        {section.group}
                      </div>
                      {section.indexes.map(renderOption)}
                    </div>
                  ),
                )}
              </div>
              {visible.length === 0 ? (
                <p className="select-popup__empty" role="status">
                  {t("common.select.noMatches")}
                </p>
              ) : null}
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
