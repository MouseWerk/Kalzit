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
  };
}

export const PanelHostContext = createContext<PanelHost>({});

export function usePanelHost(): PanelHost {
  return useContext(PanelHostContext);
}

export type VariableClick = "set" | "refused" | "none";

/**
 * Sets a dashboard variable from a click, if the dashboard has it and it takes the value. Says
 * what happened, so the panel can announce it.
 */
export function setVariableFromClick(host: PanelHost, name: string, value: string): VariableClick {
  const variables = host.variables;
  if (name === "" || variables === undefined || !variables.names.includes(name)) {
    return "none";
  }
  if (!variables.accepts(name, value)) {
    return "refused";
  }
  variables.set(name, value);
  return "set";
}
