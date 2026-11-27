import { useI18n } from "../i18n/i18n";
import {
  type AlgoStepKind,
  algoProperty,
  algoPropertyIsGroup,
  algoPropertyIsScore,
  variantOf,
} from "./algoSteps";
import { placeReason, summarySentence } from "./algoText";
import type { StepOutcome } from "./steps";

/**
 * What an algorithm step's card says after a run (board Graph082, frames 3, 15 and 16): its
 * sentence, why it computed where it did, a quiet note when its result may vary between runs,
 * and the one or two actions that fit its result or its error. The place badge itself is the
 * card's line "Läuft in ..." like every graph step's.
 */

/** What a result can be shown as on the canvas (a style rule the panel adds). */
export type ResultUse = "size" | "color" | "groups";

export interface AlgoOutcomeProps {
  step: AlgoStepKind;
  outcome: StepOutcome | undefined;
  /** Runs the step on the Kalzit server from now on (`place: server`). */
  onServer: () => void;
  /** Puts a "filter the graph" step before this one. */
  onFilterBefore: () => void;
  /** Shows the step's property on the canvas; absent where the screen draws no graph. */
  onUse?: ((use: ResultUse, property: string) => void) | undefined;
}

/** Errors a smaller graph helps with: offer a filter before the step. */
const SMALLER_HELPS = new Set([
  "steps.algorithm_too_large",
  "steps.algorithm_timeout",
  "steps.algorithm_memory",
]);

export function AlgoOutcome({ step, outcome, onServer, onFilterBefore, onUse }: AlgoOutcomeProps) {
  const { t, language } = useI18n();
  const variant = variantOf(step as unknown as { type: string } & Record<string, unknown>);
  const sentence = summarySentence(t, language, outcome?.summary);
  const reason = outcome?.ranIn === "server" ? placeReason(t, outcome.reason) : null;
  const error = outcome?.error?.reason;
  const property = algoProperty(step);
  const ran = outcome !== undefined && outcome.error === undefined && outcome.ranIn !== undefined;
  return (
    <div className="algo-outcome">
      {sentence === null ? null : <p className="algo-outcome__sentence">{sentence}</p>}
      {reason === null ? null : <p className="field__hint">{reason}</p>}
      {variant?.varies === true && outcome?.ranIn === "database" ? (
        <p className="field__hint">{t("graphSteps.algo.varies")}</p>
      ) : null}
      {error === "steps.algorithm_answer" ? (
        <button type="button" className="button button--secondary button--small" onClick={onServer}>
          {t("graphSteps.algo.computeOnServer")}
        </button>
      ) : null}
      {error !== undefined && SMALLER_HELPS.has(error) ? (
        <>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onFilterBefore}
          >
            {t("graphSteps.algo.filterBefore")}
          </button>
          {error === "steps.algorithm_too_large" ? (
            <p className="field__hint">{t("graphSteps.algo.limitAdmin")}</p>
          ) : null}
        </>
      ) : null}
      {ran && onUse !== undefined && property !== undefined ? (
        <div className="algo-outcome__uses">
          {algoPropertyIsScore(step) ? (
            <>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onUse("size", property)}
              >
                {t("graphSteps.algo.useSize")}
              </button>
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => onUse("color", property)}
              >
                {t("graphSteps.algo.useColor")}
              </button>
            </>
          ) : null}
          {algoPropertyIsGroup(step) ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onUse("groups", property)}
            >
              {t("graphSteps.algo.useGroups")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
