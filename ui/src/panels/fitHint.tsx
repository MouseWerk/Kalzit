import type { StepKind } from "../analysis/steps";
import { Icon } from "../components/Icon";
import { useI18n } from "../i18n/i18n";
import { usePanelHost } from "./host";
import "./xy/xy.css";

/** A way out of a hint: a visible step that makes the data fit, or another panel type. */
export type FitAction =
  | { kind: "step"; label: string; step: StepKind }
  | { kind: "type"; label: string; type: string };

/**
 * What a panel shows when the data do not fit it, in one pattern for every panel: a sentence
 * naming the field and the place, a button that puts the matching step into the step list
 * (where it shows and can be turned off), and a second way to a panel that takes the data as they
 * are. The panel itself never sorts, groups or converts. The buttons are there only in the panel
 * editor; on a dashboard the hint explains.
 */
export function FitHint({
  title,
  text,
  actions,
  compact = false,
}: {
  title: string;
  text: string;
  actions: readonly FitAction[];
  /** A line above a drawing instead of the whole panel. */
  compact?: boolean;
}) {
  const { t } = useI18n();
  const host = usePanelHost();
  const usable = actions.filter((a) =>
    a.kind === "step" ? host.addStep !== undefined : host.changeType !== undefined,
  );
  return (
    <div className={compact ? "fit-hint fit-hint--compact" : "fit-hint"} role="note">
      <p className="fit-hint__title">{title}</p>
      <p className="fit-hint__text">{text}</p>
      {usable.length === 0 ? (
        host.editQuery === undefined ? null : (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={host.editQuery}
          >
            {t("panels.fit.edit")}
          </button>
        )
      ) : (
        <div className="fit-hint__actions">
          {usable.map((action, i) => (
            <button
              key={action.label}
              type="button"
              className={
                i === 0
                  ? "button button--secondary button--small"
                  : "button button--ghost button--small"
              }
              onClick={() => {
                if (action.kind === "step") host.addStep?.(action.step);
                else host.changeType?.(action.type);
              }}
            >
              {action.kind === "step" ? <Icon name="plus" /> : null}
              {action.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
