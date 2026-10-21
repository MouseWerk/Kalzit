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
    set: (name: string, value: string) => void;
  };
}

export const PanelHostContext = createContext<PanelHost>({});

export function usePanelHost(): PanelHost {
  return useContext(PanelHostContext);
}
