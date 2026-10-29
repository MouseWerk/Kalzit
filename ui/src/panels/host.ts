import { createContext, useContext } from "react";

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
  };
  /**
   * The dashboard panel the panel is drawn for, where a viewer's own state of it is kept on the
   * server (a graph panel's pins and selection). Absent in Explore and the panel editor.
   */
  view?: { dashboardId: string; panelId: string };
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
