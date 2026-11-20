import { useLayoutEffect, useRef, useState } from "react";

/**
 * The `title` of a text that may end in an ellipsis: the whole text while the element cuts it,
 * none while it fits (a tooltip that repeats what is on screen is noise). Measured on the
 * element, not guessed from the text's length, so it follows the width, the font and the
 * language. The ref goes on the element that carries `text-overflow: ellipsis`.
 */
export function useEllipsisTitle<T extends HTMLElement>(text: string) {
  const ref = useRef<T>(null);
  const [cut, setCut] = useState(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new text is measured anew
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null) {
      return;
    }
    const check = () => setCut(element.scrollWidth > element.clientWidth + 1);
    check();
    if (typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(check);
    observer.observe(element);
    return () => observer.disconnect();
  }, [text]);
  return { ref, title: cut ? text : undefined };
}
