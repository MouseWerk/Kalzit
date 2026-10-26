import { type RefObject, useEffect, useState } from "react";

/**
 * Whether the element is on screen (or near it), while `active`; live subscriptions follow only
 * the panels someone can see. Without IntersectionObserver (tests, old engines) it counts as seen.
 */
export function useInView(ref: RefObject<Element | null>, active: boolean): boolean {
  const [seen, setSeen] = useState(true);
  useEffect(() => {
    const element = ref.current;
    if (!active || element === null || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry !== undefined) {
          setSeen(entry.isIntersecting);
        }
      },
      // A panel just below the fold starts following before it scrolls in.
      { rootMargin: "200px 0px" },
    );
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, active]);
  return seen;
}
