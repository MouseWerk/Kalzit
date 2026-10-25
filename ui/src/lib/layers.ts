import { useEffect, useEffectEvent } from "react";

/**
 * Escape closes the topmost open layer only (a menu inside a dialog closes before the dialog).
 * Layers register in the order the user opens them; one document listener (in the capture phase,
 * before any element handler) hands Escape to the last one.
 */
interface Layer {
  close: () => void;
  blocking: boolean;
}

const stack: Layer[] = [];

// Registered in the capture phase on the document, so it runs before any element handler; an
// Escape that confirms an input method composition is left alone.
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || event.isComposing) {
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

export interface EscapeLayerOptions {
  /**
   * Whether the layer holds back the global shortcuts while it is open, as a dialog or menu
   * does (the default). A selection inside a panel only takes Escape and leaves Ctrl+K, ?, / and
   * the rest to the shell.
   */
  blocking?: boolean;
}

/** While `open`, registers a layer that Escape closes when it is the topmost one. */
export function useEscapeLayer(
  open: boolean,
  onClose: () => void,
  { blocking = true }: EscapeLayerOptions = {},
): void {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) {
      return;
    }
    return push({ close: () => close(), blocking });
  }, [open, blocking]);
}

/** Number of open blocking layers; shortcuts should do nothing while one is open. */
export function openLayerCount(): number {
  return stack.filter((layer) => layer.blocking).length;
}
