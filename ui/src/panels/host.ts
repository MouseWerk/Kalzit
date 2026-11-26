import { createContext, useContext } from "react";
import type { StepKind } from "../analysis/steps";
import type { DownloadedFile } from "../api/client";
import type { ExportFormat, ExportLanguage, GraphExportScope } from "../api/generated/shapes";
import type { VariableValues } from "../features/dashboards/model";

/** A file of the panel's data a panel asks its page for (`PanelHost.exportData`). */
export interface PanelExportChoice {
  format: ExportFormat;
  language: ExportLanguage;
  /** For a graph: the part of it to export and where its nodes are drawn. */
  graph?: GraphExportScope;
}

/**
 * What the page around a panel offers it, beyond its data: the organization (for panels that
 * query on their own, such as explorer mode) and the dashboard's variables (for panels whose
 * clicks set one, such as a node setting `$customerId`). Explore offers no variables; a panel
 * rendered on its own offers nothing, and its interactions are simply off.
 */
export interface PanelHost {
  orgId?: string;
  variables?: {
    /** Names of the dashboard's variables that a panel may set. */
    names: readonly string[];
    /** Whether the variable takes this value (a `custom` one only its options). */
    accepts: (name: string, value: string) => boolean;
    set: (name: string, value: string) => void;
    /**
     * Names of the multi-value variables a panel may set, with several values at once (a graph
     * selection setting `$customers`). Absent where the page has none.
     */
    multi?: readonly string[];
    setMany?: (name: string, values: readonly string[]) => void;
    /**
     * The options a `query` variable's picker has loaded (undefined for other kinds): a value a
     * plugin panel sends with `setVariable` must be one of them.
     */
    loadedOptions?: (name: string) => readonly string[] | undefined;
  };
  /**
   * The dashboard's current variable values (a repeat copy's own value included), which data
   * links of document and graph panels fill in (`${region}`). Absent outside a dashboard.
   */
  linkValues?: VariableValues;
  /**
   * The dashboard panel the panel is drawn for, where a viewer's own state of it is kept on the
   * server (a graph panel's pins and selection). Absent in Explore and the panel editor.
   */
  view?: { dashboardId: string; panelId: string };
  /**
   * What Explore offers a trace: opening another trace by its id (a row of the result list, a
   * span link), the way back to the list it came from, and a span value as a tag of the search.
   * Absent on dashboards, where a click sets a variable instead.
   */
  traces?: {
    open?: (traceId: string) => void;
    back?: (() => void) | undefined;
    filter?: ((key: string, value: string) => void) | undefined;
    /** Next steps beside a search without hits: a longer time range, the filters taken out. */
    widen?: (() => void) | undefined;
    reset?: (() => void) | undefined;
  };
  /** Opens a query in Explore's editor, unrun (a graph exploration as Cypher). */
  openInExplore?: (datasourceId: string, query: unknown) => void;
  /**
   * The dashboard the panel is drawn on, also in its panel editor: a plugin's panel frame is
   * served for it (docs/api/plugins.md, "Panel plugins"). Absent for a dashboard not saved yet.
   */
  dashboardId?: string;
  /**
   * In the panel editor: takes options a panel asks for itself (a plugin's `setOptions`, after
   * its checks). Absent while viewing, where a panel cannot change its options.
   */
  editOptions?: (options: Record<string, unknown>) => void;
  /**
   * In the panel editor: puts an analysis step at the end of the panel's steps, where it shows
   * and can be turned off (a panel's hint offering the step that makes the data fit). Absent
   * while viewing: no panel changes data by itself.
   */
  addStep?: (step: StepKind) => void;
  /** In the panel editor: switches the panel to another type ("Show as XY chart"). */
  changeType?: (type: string) => void;
  /**
   * Sets the dashboard's time range to an absolute one (Unix milliseconds), as the time picker
   * does, into the address (replacing the entry). Absent outside a dashboard and while the
   * dashboard is edited, so a panel never changes a draft on its own.
   */
  setRange?: (from: number, to: number) => void;
  /**
   * Opens this panel in the panel editor, at its query: offered next to a result the query
   * should change (an empty one, a hierarchy too large to lay out). Absent for those who may not
   * edit the dashboard, and in the editor itself.
   */
  editQuery?: () => void;
  /**
   * The panel's data as a file, for panels with an export menu of their own (a graph's GraphML,
   * JSON and CSV files): the server makes the file from the panel's queries and decides whether
   * the caller may have it. `allowed` is false for members without `data:export`; the panel then
   * says what is missing instead of offering the formats. `stored` says that the saved panel is
   * exported, not the draft on screen. Absent where the page has no export (a public link, a
   * panel on its own); pictures of what the panel shows need none of this.
   */
  exportData?: {
    allowed: boolean;
    stored: boolean;
    run: (choice: PanelExportChoice, signal: AbortSignal) => Promise<DownloadedFile>;
  };
  /**
   * What a picture of the panel may say about it, read when the picture is made: the names of
   * its data sources and the time range it shows (Unix milliseconds).
   */
  about?: () => { source?: string | undefined; range?: { from: number; to: number } | undefined };
}

export const PanelHostContext = createContext<PanelHost>({});

export function usePanelHost(): PanelHost {
  return useContext(PanelHostContext);
}

export type VariableClick = "set" | "refused" | "none";

/** Whether the page has the variable as one a panel may set with several values. */
export function isMultiVariable(host: PanelHost, name: string): boolean {
  return name !== "" && host.variables?.multi?.includes(name) === true;
}

/**
 * Sets a multi-value dashboard variable to the values it takes (a `custom` one only its
 * options); "refused" when none of them is one it takes.
 */
export function setVariableValues(
  host: PanelHost,
  name: string,
  values: readonly string[],
): VariableClick {
  const variables = host.variables;
  if (variables?.setMany === undefined || !isMultiVariable(host, name)) {
    return "none";
  }
  const taken = [...new Set(values)].filter((value) => variables.accepts(name, value));
  if (taken.length === 0) {
    return "refused";
  }
  variables.setMany(name, taken);
  return "set";
}

/**
 * Sets a dashboard variable from a click, if the dashboard has it and it takes the value. Says
 * what happened, so the panel can announce it.
 */
export function setVariableFromClick(host: PanelHost, name: string, value: string): VariableClick {
  const variables = host.variables;
  if (isMultiVariable(host, name)) {
    return setVariableValues(host, name, [value]);
  }
  if (name === "" || variables === undefined || !variables.names.includes(name)) {
    return "none";
  }
  if (!variables.accepts(name, value)) {
    return "refused";
  }
  variables.set(name, value);
  return "set";
}
