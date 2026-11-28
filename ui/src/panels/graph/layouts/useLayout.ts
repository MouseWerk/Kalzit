import { useMemo, useState } from "react";
import type { GraphModel } from "../model";
import type { GraphPanelOptions } from "../options";
import { LAYOUT_MODES, type LayoutMode } from "../options";
import type { GraphView } from "../view";
import {
  type CoordinateChoice,
  coordinateChoice,
  type LayoutInput,
  type LayoutPlan,
  type LayoutProperties,
  type LayoutSettings,
  layoutOptions,
  layoutProperties,
  layoutSettings,
  type MapChoice,
  mapChoice,
  planLayout,
  timeChoice,
} from "./inputs";

/**
 * The layout a graph panel shows: chosen in its layout menu, starting from the panel's options.
 * While viewing, a choice is the viewer's own and lasts for the visit; in the panel editor it is
 * written to the panel's options (`edit`), so it is saved with the dashboard for everyone.
 */
export interface LayoutChoice {
  settings: LayoutSettings;
  /** The view keys of the radial layout's middle: the selection when it was chosen or arranged. */
  centers: readonly string[];
  /** Counts "Arrange again"; the layouts take it as their seed. */
  seed: number;
  /** Changes the layout or one of its options. `centers`: the selection, for a radial layout. */
  change: (patch: Partial<LayoutSettings>, centers?: readonly string[]) => void;
  /** Lays the nodes out anew: a force layout from another start, a radial one around `centers`. */
  rearrange: (centers: readonly string[]) => void;
  /** Goes back to the layout before the last change of layout (a cancelled computation). */
  back: () => void;
  /** Whether there is a layout to go back to. */
  canGoBack: boolean;
}

export function useLayoutChoice(
  options: GraphPanelOptions,
  mode: LayoutMode,
  edit: ((patch: Partial<GraphPanelOptions>) => void) | undefined,
): LayoutChoice {
  const stored = layoutSettings(options, mode);
  const storedKey = JSON.stringify(stored);
  const [settings, setSettings] = useState(stored);
  const [seenKey, setSeenKey] = useState(storedKey);
  // New options (the panel editor, another dashboard version) replace the viewer's choice.
  if (seenKey !== storedKey) {
    setSeenKey(storedKey);
    setSettings(stored);
  }
  const [centers, setCenters] = useState<readonly string[]>([]);
  const [seed, setSeed] = useState(0);
  const [before, setBefore] = useState<LayoutSettings | null>(null);

  function apply(next: LayoutSettings) {
    setSettings(next);
    edit?.(layoutOptions(next));
  }

  return {
    settings,
    centers,
    seed,
    change(patch, around) {
      const next = { ...settings, ...patch };
      if (next.mode !== settings.mode) setBefore(settings);
      if (around !== undefined) setCenters(around);
      apply(next);
    },
    rearrange(around) {
      setCenters(around);
      setSeed((current) => current + 1);
    },
    back() {
      if (before !== null) apply(before);
      setBefore(null);
    },
    canGoBack: before !== null,
  };
}

/** Whether each layout applies to the result, and how many nodes it places by their own value. */
export type LayoutAvailability = Record<
  LayoutMode,
  Pick<LayoutPlan, "reason" | "placed" | "total">
>;

export interface LayoutPlans {
  properties: LayoutProperties;
  /** The properties the coordinates, the map and the timeline read: chosen, or the best found. */
  resolved: {
    coordinates: CoordinateChoice | null;
    map: MapChoice | null;
    times: ReadonlyMap<number, string>;
  };
  availability: LayoutAvailability;
  /** The plan of the chosen layout, applicable or not. */
  chosen: LayoutPlan;
  /** The layout drawn: the chosen one, or the panel's own while the chosen one cannot apply. */
  effective: LayoutMode;
  /** What the drawn layout reads from the result. */
  input: LayoutInput;
}

const NO_INPUT: LayoutInput = {};

/**
 * Plans the chosen layout for a view and says which layouts could apply (the layout menu shows
 * the reason beside the ones that cannot). A layout that cannot apply is not drawn: the panel
 * keeps its own layout and says why.
 */
export function useLayoutPlans(
  model: GraphModel,
  view: GraphView,
  choice: Pick<LayoutChoice, "settings" | "centers">,
  own: LayoutMode,
  language: string,
): LayoutPlans {
  const { settings, centers } = choice;
  const properties = useMemo(() => layoutProperties(model), [model]);
  const chosen = useMemo(
    () => planLayout(model, view, properties, settings, centers, language),
    [model, view, properties, settings, centers, language],
  );
  const availability = useMemo(() => {
    const out = {} as LayoutAvailability;
    for (const mode of LAYOUT_MODES) {
      // Only these four can fail to apply; the others always place every node.
      const plan =
        mode === "coordinates" || mode === "map" || mode === "timeline" || mode === "hierarchy"
          ? planLayout(model, view, properties, { ...settings, mode }, [], language)
          : null;
      out[mode] = {
        reason: plan?.reason ?? null,
        placed: plan?.placed ?? view.nodes.length,
        total: view.nodes.length,
      };
    }
    return out;
  }, [model, view, properties, settings, language]);
  const resolved = useMemo(
    () => ({
      coordinates: coordinateChoice(model, properties, settings),
      map: mapChoice(model, properties, settings),
      times: timeChoice(model, properties, settings),
    }),
    [model, properties, settings],
  );
  const applies = chosen.reason === null;
  return {
    properties,
    resolved,
    availability,
    chosen,
    effective: applies ? settings.mode : own,
    input: applies ? chosen.input : NO_INPUT,
  };
}
