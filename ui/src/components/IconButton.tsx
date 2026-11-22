import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { useI18n } from "../i18n/i18n";
import { type TooltipAnchor, visibleBox } from "../lib/tooltipPlace";
import { Keys } from "../shortcuts/Keys";
import { nameWithShortcut, type ShortcutId, shortcutProps } from "../shortcuts/registry";
import { FloatingTooltip } from "./FloatingTooltip";
import { Icon, type IconName } from "./Icon";
import { useTip } from "./useTip";
import "./iconButton.css";
import "../shell/shellUx.css";

/**
 * On an element around controls: their tooltips open before them (to the left, into the page)
 * instead of below, as on the dashboard's rail at the window's edge.
 */
export const TIP_SIDE_ATTRIBUTE = "data-tip-side";

/** A shortcut of the registry (shortcuts/builtins.ts), shown as key caps in the tooltip. */
export type ShortcutKeys = ShortcutId;

interface TooltipProps {
  /** The text: the control's name. */
  label: string;
  shortcut?: ShortcutKeys | undefined;
  children: ReactNode;
  /** Which edge of the control the tooltip lines up with: its end (default) or its start. */
  align?: "start" | "end" | undefined;
}

/**
 * A short tooltip under a control, shown on hover and on keyboard focus, hidden again with
 * Escape (WCAG 1.4.13); `useTip` decides when. It lies above the whole page (FloatingTooltip),
 * so the bar or panel around the control cannot clip it, and it stays inside the viewport. The
 * control carries the same text as its accessible name, so the tooltip is hidden from screen
 * readers; shortcuts reach them through `aria-keyshortcuts`.
 */
export function WithTooltip({ label, shortcut, children, align = "end" }: TooltipProps) {
  const { anchorRef, shown, handlers } = useTip();

  function tipAnchor(): TooltipAnchor | null {
    const anchor = anchorRef.current;
    // A focused control that has scrolled out of view (or under a bar) takes its tooltip along.
    if (anchor === null || visibleBox(anchor) === null) {
      return null;
    }
    const { left, top, right, bottom } = anchor.getBoundingClientRect();
    const before =
      anchor.closest(`[${TIP_SIDE_ATTRIBUTE}]`)?.getAttribute(TIP_SIDE_ATTRIBUTE) === "before";
    return { control: { left, top, right, bottom }, side: before ? "before" : "below", align };
  }

  return (
    // Pointer, focus and Escape only show and hide the tooltip; the control inside takes them.
    <span className="tip-anchor" ref={anchorRef} {...handlers}>
      {children}
      {shown ? (
        <FloatingTooltip className="tip" anchor={tipAnchor}>
          <span>{label}</span>
          {shortcut === undefined ? null : <Keys id={shortcut} className="tip__keys" />}
        </FloatingTooltip>
      ) : null}
    </span>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** The accessible name, also the tooltip. */
  label: string;
  /**
   * The shortcut that does the same: shown in the tooltip, and named for assistive technology
   * (`aria-keyshortcuts`, or in the name for keys pressed one after the other).
   */
  shortcut?: ShortcutKeys | undefined;
  /** Text next to the icon (the refresh interval beside the refresh icon). */
  text?: ReactNode;
  /** Which edge the tooltip lines up with: the button's end (default) or its start. */
  tipAlign?: "start" | "end";
  ref?: Ref<HTMLButtonElement>;
}

/** A quiet toolbar button with only an icon (or an icon and a short text) and a tooltip. */
export function IconButton({
  icon,
  label,
  shortcut,
  text,
  tipAlign = "end",
  className,
  ref,
  ...rest
}: IconButtonProps) {
  const { language } = useI18n();
  return (
    <WithTooltip label={label} shortcut={shortcut} align={tipAlign}>
      <button
        ref={ref}
        type="button"
        className={
          className === undefined
            ? "button button--ghost icon-button"
            : `button button--ghost icon-button ${className}`
        }
        aria-label={shortcut === undefined ? label : nameWithShortcut(label, shortcut, language)}
        {...(shortcut === undefined ? {} : shortcutProps(shortcut))}
        {...rest}
      >
        <Icon name={icon} />
        {text === undefined ? null : <span className="icon-button__text">{text}</span>}
      </button>
    </WithTooltip>
  );
}
