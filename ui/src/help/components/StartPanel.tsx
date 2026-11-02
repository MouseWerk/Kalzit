import { type ReactNode, useId } from "react";
import { ShowQuery } from "./Snippet";
import "../help.css";

export interface StartAction {
  id: string;
  title: string;
  /** The code the action fills in, shown under "Show the query" before it is used. */
  code: string;
  onUse: () => void;
}

/**
 * The start of a screen for someone new to it: what is there in two or three sentences, an
 * optional picker (a table, a collection), and ready actions that each fill in and run one safe
 * example. `footer` holds the other ways in: building without code, asking in plain language,
 * the guide.
 */
export function StartPanel({
  title,
  lead,
  picker,
  actions,
  empty,
  footer,
}: {
  title: string;
  lead: string;
  picker?: ReactNode;
  actions: readonly StartAction[];
  /** Shown instead of the actions when there are none (nothing to pick yet). */
  empty?: string | undefined;
  footer?: ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="help-start" aria-labelledby={headingId}>
      <h2 className="help-start__title" id={headingId}>
        {title}
      </h2>
      <p className="help-start__lead">{lead}</p>
      {picker}
      {actions.length === 0 ? (
        empty === undefined ? null : (
          <p className="help-start__empty">{empty}</p>
        )
      ) : (
        <ul className="help-start__actions">
          {actions.map((action) => (
            <li key={action.id} className="help-start__action">
              <button
                type="button"
                className="button button--secondary help-start__use"
                onClick={action.onUse}
              >
                {action.title}
              </button>
              {action.code === "" ? null : <ShowQuery code={action.code} />}
            </li>
          ))}
        </ul>
      )}
      {footer === undefined ? null : <div className="help-start__footer">{footer}</div>}
    </section>
  );
}
