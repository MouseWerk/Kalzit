import { createContext, useContext } from "react";

/**
 * The place in the shell's content header where a page's breadcrumbs go, right after the
 * sidebar toggle. Null outside the shell (or before it mounted): breadcrumbs then stay in place.
 */
export const CrumbSlotContext = createContext<HTMLElement | null>(null);

export function useCrumbSlot(): HTMLElement | null {
  return useContext(CrumbSlotContext);
}

/**
 * Whether the sidebar shows its full column (true) or not: collapsed to the rail or, on narrow
 * screens, a bar on top. Pages put what the column would hold (the setup card) on the page then.
 */
export const SidebarColumnContext = createContext<boolean>(true);

export function useSidebarColumn(): boolean {
  return useContext(SidebarColumnContext);
}
