import {
  type KeyboardEvent,
  type ReactNode,
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Icon } from "../../../components/Icon";
import { placeMenu } from "../../../components/menuPlacement";
import { isInsideSelectPopup, Select } from "../../../components/Select";
import { type Translate, useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import {
  LAYOUT_LANES,
  LAYOUT_MODES,
  LAYOUT_ORDERS,
  type LayoutLanes,
  type LayoutMode,
  type LayoutOrder,
} from "../options";
import {
  type CoordinateChoice,
  HIERARCHY_NODE_LIMIT,
  type LayoutProperties,
  type LayoutSettings,
} from "./inputs";
import { LayoutGlyph } from "./LayoutGlyph";
import type { LayoutAvailability } from "./useLayout";
import "../../../components/iconButton.css";
import "./layouts.css";

export interface LayoutMenuProps {
  settings: LayoutSettings;
  availability: LayoutAvailability;
  properties: LayoutProperties;
  /** The properties the coordinates and the timeline read now, the panel's or the best found. */
  resolved: { coordinates: CoordinateChoice | null; times: ReadonlyMap<number, string> };
  /** The result's labels by index, for the timeline's property per label. */
  labels: readonly string[];
  /** Names of the selected nodes: a radial layout chosen now stands around them. */
  selection: readonly string[];
  /** Names of the nodes the radial layout stands around; empty: the best connected node. */
  centers: readonly string[];
  /** How many nodes are pinned; "Release" is offered above zero. */
  pinned: number;
  onChange: (patch: Partial<LayoutSettings>) => void;
  /** Null where the layout shown cannot come out differently (only forces and radial can). */
  onRearrange: (() => void) | null;
  onRelease: (() => void) | null;
}

/** The sentence under a layout's name: what it does, or why it cannot apply to this result. */
export function layoutAbout(
  t: Translate,
  number: Intl.NumberFormat,
  mode: LayoutMode,
  props: Pick<LayoutMenuProps, "settings" | "availability" | "selection">,
): string {
  const { reason, placed, total } = props.availability[mode];
  const limit = number.format(HIERARCHY_NODE_LIMIT);
  if (reason === "tooLarge") {
    return t("graph.layout.reason.tooLarge", { limit, count: number.format(total) });
  }
  if (reason !== null) return t(`graph.layout.reason.${reason}`);
  const order = t(`graph.layout.order.${props.settings.order}`);
  switch (mode) {
    case "force":
      return t("graph.layout.about.force");
    case "hierarchy":
      return t("graph.layout.about.hierarchy", { limit });
    case "radial": {
      const [first] = props.selection;
      if (first === undefined) return t("graph.layout.about.radial.none");
      return props.selection.length === 1
        ? t("graph.layout.about.radial.one", { name: first })
        : t("graph.layout.about.radial.many", { count: number.format(props.selection.length) });
    }
    case "circular":
      return t("graph.layout.about.circular", { order });
    case "grid":
      return t("graph.layout.about.grid", { order });
    case "coordinates":
      return t("graph.layout.about.coordinates");
    case "timeline":
      return t("graph.layout.about.timeline", {
        placed: number.format(placed),
        count: number.format(total),
      });
  }
}

function menuItems(menu: HTMLElement | null): HTMLElement[] {
  return menu === null
    ? []
    : Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"]'));
}

function focusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>("button:not([disabled]), [tabindex]"));
}

/**
 * The layout of a graph panel as a button with a menu (Graph081 board, frame 12): one row per
 * layout with a sentence on what it does, or why it cannot apply to this result, "Arrange again"
 * and releasing pinned nodes; under the menu the options of the chosen layout. The chosen row is
 * a quiet tint with a check. Choosing a layout keeps the menu open, so its options are at hand;
 * Escape, Tab past its end or a click elsewhere closes it.
 *
 * The map layout joins the rows with the map panel (between coordinates and timeline).
 */
export function LayoutMenu(props: LayoutMenuProps) {
  const { settings, availability, pinned, onChange, onRearrange, onRelease } = props;
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const popupId = useId();
  // Where the popup is drawn: the page's main landmark when the button sits in it.
  const [host, setHost] = useState<Element | null>(null);

  function close(returnFocus: boolean) {
    setOpen(false);
    if (returnFocus) buttonRef.current?.focus();
  }

  function show(button: HTMLElement) {
    setHost(button.closest("main") ?? document.body);
    setOpen(true);
  }

  useEscapeLayer(open, () => close(true));

  // Placed under the button when it opens and when its content changes height (other options).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the mode changes the popup's size
  useLayoutEffect(() => {
    const button = buttonRef.current;
    const popup = popupRef.current;
    if (open && button !== null && popup !== null) placeMenu(button, popup);
  }, [open, settings.mode]);

  // The chosen row takes the focus when the menu opens.
  useEffect(() => {
    if (!open) return;
    const items = menuItems(menuRef.current);
    (items.find((item) => item.getAttribute("aria-checked") === "true") ?? items[0])?.focus();
  }, [open]);

  const onOutside = useEffectEvent((event: PointerEvent) => {
    const target = event.target;
    if (
      target instanceof Node &&
      anchorRef.current?.contains(target) !== true &&
      popupRef.current?.contains(target) !== true &&
      // The lists of the options' pickers are drawn elsewhere in the page.
      !isInsideSelectPopup(target)
    ) {
      close(false);
    }
  });
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => onOutside(event);
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", pointer);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  function onPopupKey(event: KeyboardEvent<HTMLDivElement>) {
    const popup = popupRef.current;
    if (popup === null) return;
    if (event.key === "Tab") {
      // The popup sits at the end of the page: Tab past its end goes back to its button.
      const stops = focusable(popup).filter((element) => element.tabIndex >= 0);
      const edge = event.shiftKey ? stops[0] : stops.at(-1);
      if (document.activeElement === edge) {
        event.preventDefault();
        close(true);
      }
      return;
    }
    const items = menuItems(menuRef.current);
    const index = items.indexOf(document.activeElement as HTMLElement);
    // Arrow keys move between the rows; in the options below they belong to the pickers.
    if (index < 0) return;
    let next: HTMLElement | undefined;
    if (event.key === "ArrowDown") next = items[(index + 1) % items.length];
    else if (event.key === "ArrowUp") next = items[(index - 1 + items.length) % items.length];
    else if (event.key === "Home") next = items[0];
    else if (event.key === "End") next = items.at(-1);
    else return;
    event.preventDefault();
    next?.focus();
  }

  const name = t(`graph.layout.${settings.mode}`);
  return (
    <span className="menu-anchor graph-layouts" ref={anchorRef}>
      <button
        ref={buttonRef}
        type="button"
        className="button button--ghost button--small graph__tool graph-layouts__button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? popupId : undefined}
        aria-label={t("graph.layout.button", { name })}
        onClick={(event) => (open ? close(false) : show(event.currentTarget))}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            show(event.currentTarget);
          }
        }}
      >
        <LayoutGlyph mode={settings.mode} />
        {name}
        <Icon name="chevronDown" />
      </button>
      {open
        ? createPortal(
            // biome-ignore lint/a11y/noStaticElementInteractions: keys of the menu and options inside
            <div
              ref={popupRef}
              id={popupId}
              className="menu toolbar-menu__list graph-layouts__popup"
              onKeyDown={onPopupKey}
            >
              <div ref={menuRef} role="menu" aria-label={t("graph.layout.label")}>
                {/* "Karte" slot (map panel, Graph081 frame 12): the map layout's row goes between
                    coordinates and timeline once LAYOUT_MODES lists it. */}
                {LAYOUT_MODES.map((mode) => {
                  const unavailable = availability[mode].reason !== null;
                  const checked = mode === settings.mode;
                  return (
                    <button
                      key={mode}
                      type="button"
                      role="menuitemradio"
                      aria-checked={checked}
                      // One Tab stop for the rows (the chosen one); arrow keys move between them.
                      tabIndex={checked ? 0 : -1}
                      // aria-disabled, not disabled: the row stays in the arrow-key order, so
                      // its name and why it cannot apply are still read.
                      aria-disabled={unavailable ? true : undefined}
                      className="menu__item graph-layouts__row"
                      onClick={() => {
                        if (!unavailable && !checked) onChange({ mode });
                      }}
                    >
                      <LayoutGlyph mode={mode} />
                      <span className="graph-layouts__text">
                        <span className="graph-layouts__name">{t(`graph.layout.${mode}`)}</span>
                        <span className="graph-layouts__about">
                          {layoutAbout(t, number, mode, props)}
                        </span>
                      </span>
                      <span className="toolbar-menu__check" aria-hidden="true">
                        {checked ? <Icon name="check" /> : null}
                      </span>
                    </button>
                  );
                })}
                {onRearrange === null && !(pinned > 0 && onRelease !== null) ? null : (
                  <hr className="toolbar-menu__separator" />
                )}
                {onRearrange === null ? null : (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="menu__item"
                    onClick={() => {
                      close(true);
                      onRearrange();
                    }}
                  >
                    <Icon name="refresh" />
                    <span className="toolbar-menu__label">{t("graph.layout.rearrange")}</span>
                    <kbd className="kbd toolbar-menu__key">{t("graph.layout.rearrangeKey")}</kbd>
                  </button>
                )}
                {pinned > 0 && onRelease !== null ? (
                  <button
                    type="button"
                    role="menuitem"
                    tabIndex={-1}
                    className="menu__item"
                    onClick={() => {
                      close(true);
                      onRelease();
                    }}
                  >
                    <Icon name="pin" />
                    <span className="toolbar-menu__label">
                      {t(pinned === 1 ? "graph.layout.release.one" : "graph.layout.release.other", {
                        count: number.format(pinned),
                      })}
                    </span>
                  </button>
                ) : null}
              </div>
              <LayoutOptions {...props} />
            </div>,
            host ?? document.body,
          )
        : null}
    </span>
  );
}

function Field({ label, children }: { label: string; children: (id: string) => ReactNode }) {
  const id = useId();
  return (
    <span className="graph-layouts__field">
      <label className="graph-layouts__label" htmlFor={id}>
        {label}
      </label>
      {children(id)}
    </span>
  );
}

/** The options of the chosen layout, under the menu; each layout has its own. */
function LayoutOptions(props: LayoutMenuProps) {
  const { settings, properties, resolved, labels, centers, onChange } = props;
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const name = t(`graph.layout.${settings.mode}`);
  let fields: ReactNode = null;
  let hint: string | null = null;
  switch (settings.mode) {
    case "force":
      return null;
    case "hierarchy":
      hint = t("graph.layout.hint.hierarchy", { limit: number.format(HIERARCHY_NODE_LIMIT) });
      break;
    case "radial": {
      const [first] = centers;
      fields = (
        <p className="graph-layouts__fact">
          <span className="graph-layouts__label">{t("graph.layout.option.center")}</span>
          {first === undefined
            ? t("graph.layout.center.best")
            : centers.length === 1
              ? t("graph.layout.center.one", { name: first })
              : t("graph.layout.center.many", { count: number.format(centers.length) })}
        </p>
      );
      hint = t("graph.layout.hint.radial");
      break;
    }
    case "circular":
    case "grid":
      fields = (
        <>
          <Field label={t("graph.layout.option.order")}>
            {(id) => (
              <Select
                id={id}
                value={settings.order}
                onChange={(order) => onChange({ order: order as LayoutOrder })}
              >
                {LAYOUT_ORDERS.map((order) => (
                  <option key={order} value={order}>
                    {t(`graph.layout.order.${order}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("graph.layout.option.direction")}>
            {(id) => (
              <Select
                id={id}
                value={settings.descending ? "desc" : "asc"}
                onChange={(direction) => onChange({ descending: direction === "desc" })}
              >
                <option value="asc">{t("graph.layout.direction.asc")}</option>
                <option value="desc">{t("graph.layout.direction.desc")}</option>
              </Select>
            )}
          </Field>
        </>
      );
      break;
    case "coordinates": {
      const choice = resolved.coordinates;
      const axis = (which: "x" | "y") => (
        <Field label={t(`graph.layout.option.${which}`)}>
          {(id) => (
            <Select
              id={id}
              value={choice?.kind === "xy" ? choice[which] : ""}
              disabled={properties.numbers.length === 0}
              // A number property chosen by hand takes the place back from the point.
              onChange={(key) =>
                onChange({
                  x: choice?.kind === "xy" ? choice.x : "",
                  y: choice?.kind === "xy" ? choice.y : "",
                  [which]: key,
                  point: "",
                })
              }
            >
              <option value="" hidden>
                {t("graph.layout.option.none")}
              </option>
              {properties.numbers.map((property) => (
                <option key={property.key} value={property.key}>
                  {property.key}
                </option>
              ))}
            </Select>
          )}
        </Field>
      );
      fields = (
        <>
          {axis("x")}
          {axis("y")}
          <Field label={t("graph.layout.option.point")}>
            {(id) => (
              <Select
                id={id}
                value={choice?.kind === "point" ? choice.point : ""}
                disabled={properties.points.length === 0}
                onChange={(point) => onChange({ point })}
              >
                <option value="">{t("graph.layout.option.none")}</option>
                {properties.points.map((property) => (
                  <option key={property.key} value={property.key}>
                    {t("graph.layout.option.pointName", { name: property.key })}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={t("graph.layout.option.axes")}>
            {(id) => (
              <Select
                id={id}
                value={settings.axes ? "show" : "hide"}
                onChange={(axes) => onChange({ axes: axes === "show" })}
              >
                <option value="show">{t("graph.layout.axes.show")}</option>
                <option value="hide">{t("graph.layout.axes.hide")}</option>
              </Select>
            )}
          </Field>
        </>
      );
      hint = t("graph.layout.hint.coordinates");
      break;
    }
    case "timeline":
      fields = (
        <>
          {[...properties.timesByLabel]
            .sort(([a], [b]) => a - b)
            .map(([label, list]) => (
              <Field
                key={label}
                label={t("graph.layout.option.time", {
                  label: labels[label] ?? t("graph.cluster.unlabelled"),
                })}
              >
                {(id) => (
                  <Select
                    id={id}
                    value={resolved.times.get(label) ?? ""}
                    // Nodes without a label have no name to keep a choice under.
                    disabled={labels[label] === undefined}
                    onChange={(key) =>
                      onChange({ time: { ...settings.time, [labels[label] as string]: key } })
                    }
                  >
                    {list.map((property) => (
                      <option key={property.key} value={property.key}>
                        {property.key}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
            ))}
          <Field label={t("graph.layout.option.lanes")}>
            {(id) => (
              <Select
                id={id}
                value={settings.lanes}
                onChange={(lanes) => onChange({ lanes: lanes as LayoutLanes })}
              >
                {LAYOUT_LANES.map((lanes) => (
                  <option key={lanes} value={lanes}>
                    {t(`graph.layout.lanes.${lanes}`)}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </>
      );
      hint = t("graph.layout.hint.timeline");
      break;
  }
  return (
    // biome-ignore lint/a11y/useSemanticElements: a group of pickers, not a field set
    <div
      className="graph-layouts__options"
      role="group"
      aria-label={t("graph.layout.options", { name })}
    >
      <p className="menu__label graph-layouts__options-title">{name}</p>
      {fields === null ? null : <div className="graph-layouts__fields">{fields}</div>}
      {hint === null ? null : <p className="graph-layouts__hint">{hint}</p>}
    </div>
  );
}
