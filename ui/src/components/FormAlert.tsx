import type { ReactNode } from "react";
import { Icon } from "./Icon";

/**
 * The form-level error region. The live region stays mounted (and in the accessibility tree) while
 * the form is visible, because screen readers only announce changes inside a region that already
 * existed; the visible notice is rendered inside it only when there is something to say.
 */
export function FormAlert({ children, className }: { children?: ReactNode; className?: string }) {
  const empty = children === null || children === undefined || children === false;
  return (
    <div
      className={className === undefined ? "form-alert" : `form-alert ${className}`}
      role="alert"
      aria-atomic="true"
    >
      {empty ? null : (
        <div className="notice notice--danger">
          <Icon name="alert" />
          <div>{children}</div>
        </div>
      )}
    </div>
  );
}
