import { createContext, type ReactNode, useContext } from "react";
import { createPortal } from "react-dom";

/**
 * The place in a settings section's header where the section puts its main actions: `null` until
 * the header is in the page, `undefined` outside a section page.
 */
export const SectionActionsSlot = createContext<HTMLElement | null | undefined>(undefined);

/**
 * Shows a section's main actions on the right of its header, as the boards draw them (for
 * example "Anbieter hinzufügen" on Verwaltung > Anmeldung). Outside a section page they stay where
 * they are rendered.
 */
export function SectionActions({ children }: { children: ReactNode }) {
  const slot = useContext(SectionActionsSlot);
  if (slot === undefined) {
    return <>{children}</>;
  }
  return slot === null ? null : createPortal(children, slot);
}
