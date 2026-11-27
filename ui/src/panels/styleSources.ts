import { createContext, useContext } from "react";
import type { GraphSet } from "../api/generated/shapes";
import type { GraphStyle } from "./graph/style/schema";

/**
 * What the panel editor offers the style rules of graph data (Graph081 board, frames 8 to 11):
 * the graphs of the preview's results, which the rules are counted on (also for a table made
 * from a graph), and the other panels of the dashboard with their rules, for "Regeln von anderem
 * Panel übernehmen". Absent outside the panel editor.
 */
export interface StyleSources {
  graphs: readonly GraphSet[];
  panels: readonly { id: string; title: string; style: GraphStyle }[];
}

export const StyleSourcesContext = createContext<StyleSources | null>(null);

export function useStyleSources(): StyleSources | null {
  return useContext(StyleSourcesContext);
}
