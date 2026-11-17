import { lazyPanel } from "../lazy";
import { TracePreview } from "../picker/previews";
import type { PanelPlugin } from "../types";
import { parseTraceOptions, type TracePanelOptions } from "./options";

/**
 * Traces as a list, or one trace as a waterfall (docs/guide/traces.md). It takes the `trace`
 * shape and, for the list, a table of traces: a search's answer or a trace table step.
 */
export const tracePanel: PanelPlugin<TracePanelOptions> = {
  type: "trace",
  name: "analysis.shape.trace",
  description: "traces.panel.about",
  shapes: ["trace"],
  options: parseTraceOptions,
  Panel: lazyPanel(() => import("./TracePanel").then((m) => m.TracePanel)),
  Editor: lazyPanel(() => import("./TracePanel").then((m) => m.TraceEditor)),
  Preview: TracePreview,
};
