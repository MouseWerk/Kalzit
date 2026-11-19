import { loadArea } from "../../i18n/i18n";
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
  description: "panels.describe.trace",
  shapes: ["trace"],
  options: parseTraceOptions,
  // With the texts of the trace screens, which no other page needs.
  Panel: lazyPanel(() =>
    loadArea("traces")
      .then(() => import("./TracePanel"))
      .then((m) => m.TracePanel),
  ),
  Editor: lazyPanel(() =>
    loadArea("traces")
      .then(() => import("./TracePanel"))
      .then((m) => m.TraceEditor),
  ),
  Preview: TracePreview,
};
