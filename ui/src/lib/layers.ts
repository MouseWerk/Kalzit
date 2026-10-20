import { useEffect, useEffectEvent } from "react";

/**
 * Escape closes the topmost open layer only (a menu inside a dialog closes before the dialog).
 * Layers register in the order the user opens them; one document listener (in the capture phase,
 * before any element handler) hands Escape to the last one.
 */
interface Layer {
  close: () => void;
}

const stack: Layer[] = [];

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) {
    return;
  }
  const top = stack.at(-1);
  if (top === undefined) {
    return;
  }
  event.preventDefault();
  event.stopPropagation();
  top.close();
}

function push(layer: Layer): () => void {
  if (stack.length === 0) {
    document.addEventListener("keydown", onKeyDown, true);
  }
  stack.push(layer);
  return () => {
    const index = stack.lastIndexOf(layer);
    if (index !== -1) {
      stack.splice(index, 1);
    }
    if (stack.length === 0) {
      document.removeEventListener("keydown", onKeyDown, true);
    }
  };
}

/** While `open`, registers a layer that Escape closes when it is the topmost one. */
export function useEscapeLayer(open: boolean, onClose: () => void): void {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) {
      return;
    }
    return push({ close: () => close() });
  }, [open]);
}

/** Number of open layers; shortcuts should do nothing while a layer is open. */
export function openLayerCount(): number {
  return stack.length;
}
