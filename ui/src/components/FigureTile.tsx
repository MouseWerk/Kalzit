import type { ReactNode } from "react";
import { useEllipsisTitle } from "./useEllipsisTitle";
import "./figureTile.css";

/**
 * A row of figure tiles: a few numbers that sum up the page above its list (shares,
 * provisioning, an import report, SCIM activity). The tile is the one of Start without its
 * drawing: a raised card, a muted sentence-case label, the number, and an optional muted note.
 */
export function FigureTiles({
  label,
  className,
  children,
}: {
  /** Names the row for screen readers where the heading above does not. */
  label?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <ul
      className={className === undefined ? "figure-tiles" : `figure-tiles ${className}`}
      aria-label={label}
    >
      {children}
    </ul>
  );
}

/** One figure: what it counts, the value, and a line that explains or lists it. */
export function FigureTile({
  label,
  value,
  note,
  small = false,
}: {
  label: ReactNode;
  value: ReactNode;
  note?: ReactNode;
  /** A value that is a date or a sentence rather than a number, set a step smaller. */
  small?: boolean;
}) {
  // Only a label that is plain text has a text to show whole; anything else names itself.
  const cut = useEllipsisTitle<HTMLSpanElement>(typeof label === "string" ? label : "");
  return (
    <li className="figure-tile">
      <span
        ref={cut.ref}
        className="figure-tile__label"
        title={typeof label === "string" ? cut.title : undefined}
      >
        {label}
      </span>
      <span
        className={small ? "figure-tile__value figure-tile__value--small" : "figure-tile__value"}
      >
        {value}
      </span>
      {note === undefined || note === null ? null : (
        <span className="figure-tile__note">{note}</span>
      )}
    </li>
  );
}
