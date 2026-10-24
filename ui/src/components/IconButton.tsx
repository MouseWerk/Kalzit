import {
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  useState,
} from "react";
import { Icon, type IconName } from "./Icon";
import "./iconButton.css";
import "../shell/shellUx.css";

/** A tooltip's keys, each shown as a key cap: ["t", "←"] reads "t ←" (pressed one after the other). */
export type ShortcutKeys = readonly string[];

interface TooltipProps {
  /** The text: the control's name. */
  label: string;
  shortcut?: ShortcutKeys | undefined;
  children: ReactNode;
  className?: string | undefined;
}

/**
 * A short tooltip above a control, shown on hover and on keyboard focus, hidden again with
 * Escape (WCAG 1.4.13). The control carries the same text as its accessible name, so the tooltip
 * is hidden from screen readers; shortcuts reach them through `aria-keyshortcuts`.
 */
export function WithTooltip({ label, shortcut, children, className }: TooltipProps) {
  const [dismissed, setDismissed] = useState(false);
  function onKeyDown(event: KeyboardEvent<HTMLSpanElement>) {
    if (event.key === "Escape" && !dismissed) {
      setDismissed(true);
    }
  }
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: Escape only hides the tooltip; the control inside takes the keys
    <span
      className={className === undefined ? "tip-anchor" : `tip-anchor ${className}`}
      data-tip-dismissed={dismissed ? "" : undefined}
      onKeyDown={onKeyDown}
      onPointerLeave={() => setDismissed(false)}
      onBlur={() => setDismissed(false)}
    >
      {children}
      <span className="tip" aria-hidden="true">
        <span>{label}</span>
        {shortcut === undefined || shortcut.length === 0 ? null : (
          <span className="tip__keys">
            {shortcut.map((key, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: keys repeat ("t", "t"), positions do not
              <kbd key={index} className="kbd">
                {key}
              </kbd>
            ))}
          </span>
        )}
      </span>
    </span>
  );
}

interface IconButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: IconName;
  /** The accessible name, also the tooltip. */
  label: string;
  /** Keys shown in the tooltip; `ariaShortcut` names them for assistive technology. */
  shortcut?: ShortcutKeys | undefined;
  ariaShortcut?: string | undefined;
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
  ariaShortcut,
  text,
  tipAlign = "end",
  className,
  ref,
  ...rest
}: IconButtonProps) {
  return (
    <WithTooltip
      label={label}
      shortcut={shortcut}
      className={tipAlign === "start" ? "tip-anchor--start" : undefined}
    >
      <button
        ref={ref}
        type="button"
        className={
          className === undefined
            ? "button button--ghost icon-button"
            : `button button--ghost icon-button ${className}`
        }
        aria-label={label}
        aria-keyshortcuts={ariaShortcut}
        {...rest}
      >
        <Icon name={icon} />
        {text === undefined ? null : <span className="icon-button__text">{text}</span>}
      </button>
    </WithTooltip>
  );
}
