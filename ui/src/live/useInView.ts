import { useEffect, useState } from "react";

/** How long an element must stay out of view before it counts as unseen. */
export const LEAVE_DELAY_MS = 1_500;

/**
 * Whether an element is on screen (or near it), while `active`; live subscriptions follow only
 * the panels someone can see. Pass the returned function as (or inside) the element's ref; the
 * element is observed from the moment it is set. Coming into view counts at once, leaving only
 * after `LEAVE_DELAY_MS`, so scrolling past a panel does not end and start its subscription.
 * It starts unseen until the observer reports; without IntersectionObserver (old engines) every
 * element counts as seen.
 */
export function useInView(active: boolean): [boolean, (element: Element | null) => void] {
  const [element, setElement] = useState<Element | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === "undefined");
  useEffect(() => {
    if (!active || element === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    let leaving: ReturnType<typeof setTimeout> | undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry === undefined) {
          return;
        }
        clearTimeout(leaving);
        if (entry.isIntersecting) {
          setSeen(true);
        } else {
          leaving = setTimeout(() => setSeen(false), LEAVE_DELAY_MS);
        }
      },
      // A panel just below the fold starts following before it scrolls in.
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => {
      clearTimeout(leaving);
      observer.disconnect();
    };
  }, [element, active]);
  return [seen, setElement];
}
