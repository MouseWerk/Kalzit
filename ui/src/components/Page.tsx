import { createContext, type ReactNode, use, useState } from "react";
import { createPortal } from "react-dom";

/** Where a page's header actions go, set by Page for the content inside it. */
const ActionsSlotContext = createContext<HTMLElement | null>(null);

/**
 * Page body inside the app shell: one h1 with an optional lead line on the left, the page's
 * actions on the right (PageActions, from anywhere inside), then the content.
 */
export function Page({
  title,
  lead,
  children,
}: {
  title: string;
  lead?: string;
  children: ReactNode;
}) {
  // Set from a ref callback, so actions move into the header before the first paint.
  const [slot, setSlot] = useState<HTMLElement | null>(null);
  return (
    <div className="page">
      <div className="page__top">
        <div className="page__header">
          <h1>{title}</h1>
          {lead === undefined ? null : <p className="page__lead">{lead}</p>}
        </div>
        <div ref={setSlot} className="page__actions" />
      </div>
      <ActionsSlotContext value={slot}>{children}</ActionsSlotContext>
    </div>
  );
}

/**
 * Buttons and links for the page as a whole (Add, Trash), shown on the right of its heading as
 * on the blueprint; rendered where the list that decides them is.
 */
export function PageActions({ children }: { children: ReactNode }) {
  const slot = use(ActionsSlotContext);
  return slot === null ? null : createPortal(children, slot);
}
