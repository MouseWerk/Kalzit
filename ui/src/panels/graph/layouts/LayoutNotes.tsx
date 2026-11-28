import { useEffect, useRef, useState } from "react";
import { type Translate, useI18n } from "../../../i18n/i18n";
import type { LayoutMode } from "../layoutProtocol";
import { HIERARCHY_NODE_LIMIT, type LayoutPlan } from "./inputs";
import "./layouts.css";

/** A layout is said to be at work once it has taken this long: most finish before anyone looks. */
export const WORK_NOTE_DELAY_MS = 250;

/**
 * A layout at work, over the drawing (Graph081 board, frame 14): which one, how many nodes it has
 * placed, and Cancel, which leaves everything as it was. The old drawing stays until the new one
 * is there.
 */
export function LayoutWork({
  mode,
  work,
  onCancel,
}: {
  mode: LayoutMode;
  work: { done: number; total: number } | null;
  /** Null where there is no layout to go back to. */
  onCancel: (() => void) | null;
}) {
  const { t, language } = useI18n();
  const number = new Intl.NumberFormat(language);
  const working = work !== null;
  const [late, setLate] = useState(false);
  // What is said aloud: the start once, and the end once, only for a layout that was seen at
  // work. The counter is for the eyes (it changes several times a second).
  const seen = useRef(false);
  const [spoken, setSpoken] = useState<"" | "start" | "done">("");
  useEffect(() => {
    if (!working) {
      if (seen.current) setSpoken("done");
      seen.current = false;
      setLate(false);
      return;
    }
    setSpoken("");
    const timer = setTimeout(() => {
      seen.current = true;
      setLate(true);
      setSpoken("start");
    }, WORK_NOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [working]);
  const name = t(`graph.layout.${mode}`);
  return (
    <>
      <p className="visually-hidden" role="status">
        {spoken === ""
          ? ""
          : t(`graph.layout.working${spoken === "start" ? "Start" : "Done"}`, { name })}
      </p>
      {work === null || !late ? null : (
        <div className="graph-layouts__work">
          <p className="graph-layouts__work-text" aria-hidden="true">
            {t("graph.layout.working", {
              name,
              done: number.format(work.done),
              count: number.format(work.total),
            })}
          </p>
          {onCancel === null ? null : (
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={onCancel}
            >
              {t("graph.layout.cancel")}
            </button>
          )}
        </div>
      )}
    </>
  );
}

/**
 * The line above the graph for a layout that could not place every node (Graph081 board, frames
 * 13 and 15): "11 of 15 arranged by coordinates, 4 without a value", "7 of 8 on the map, 1
 * without a place". Null when all nodes have a place.
 */
export function placedText(
  t: Translate,
  number: Intl.NumberFormat,
  mode: LayoutMode,
  plan: Pick<LayoutPlan, "placed" | "total" | "reason">,
): string | null {
  if (plan.reason !== null || plan.placed >= plan.total) return null;
  if (mode !== "coordinates" && mode !== "map" && mode !== "timeline") return null;
  return t(`graph.layout.placed.${mode}`, {
    placed: number.format(plan.placed),
    count: number.format(plan.total),
    rest: number.format(plan.total - plan.placed),
  });
}

/**
 * Why the chosen layout is not drawn, and what the panel shows instead (Graph081 board, frame
 * 14): "Hierarchy lays out up to 10,000 drawn nodes. This panel draws 14,200 (this panel's limit:
 * 20,000). The layout stays at Forces."
 */
export function refusedText(
  t: Translate,
  number: Intl.NumberFormat,
  chosen: LayoutMode,
  shown: LayoutMode,
  plan: Pick<LayoutPlan, "total" | "reason">,
  panelLimit: number,
): string | null {
  if (plan.reason === null) return null;
  const reason =
    plan.reason === "tooLarge"
      ? t("graph.layout.refused.tooLarge", {
          layout: t(`graph.layout.${chosen}`),
          limit: number.format(HIERARCHY_NODE_LIMIT),
          count: number.format(plan.total),
          panelLimit: number.format(panelLimit),
        })
      : t(`graph.layout.reason.${plan.reason}`);
  return t("graph.layout.refused", { reason, name: t(`graph.layout.${shown}`) });
}
