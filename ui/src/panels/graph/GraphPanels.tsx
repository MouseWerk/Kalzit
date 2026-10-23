import type { PanelEditorProps, PanelProps } from "../types";
import { GraphEditor } from "./GraphEditor";
import { GraphPanel } from "./GraphPanel";
import type { GraphPanelOptions } from "./options";

/** The network and hierarchy panels' components, loaded with the first of them (lazy.tsx). */

export function NetworkPanel(props: PanelProps<GraphPanelOptions>) {
  return <GraphPanel {...props} mode="force" />;
}

export function NetworkEditor(props: PanelEditorProps<GraphPanelOptions>) {
  return <GraphEditor {...props} network />;
}

export function HierarchyPanel(props: PanelProps<GraphPanelOptions>) {
  return <GraphPanel {...props} mode="hierarchy" />;
}

export function HierarchyEditor(props: PanelEditorProps<GraphPanelOptions>) {
  return <GraphEditor {...props} network={false} />;
}
