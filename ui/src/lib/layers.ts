import { useEffect, useEffectEvent } from "react";
import { isComposingKey } from "./ime";

/**
 * Escape closes the topmost open layer only (a menu inside a dialog closes before the dialog).
 * Layers register in the order the user opens them; one document listener (in the capture phase,
 * before any element handler) hands Escape to the last one.
 */
interface Layer {
  close: () => void;
  blocking: boolean;
  /** Sits under every layer that is not a base, however late it registers. */
  base: boolean;
}

const stack: Layer[] = [];

// Registered in the capture phase on the document, so it runs before any element handler; an
// Escape that confirms an input method composition is left alone.
function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== "Escape" || isComposingKey(event)) {
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
  if (layer.base) {
    // After the other bases, before everything opened on top of the page.
    const above = stack.findIndex((other) => !other.base);
    stack.splice(above === -1 ? stack.length : above, 0, layer);
  } else {
    stack.push(layer);
  }
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
  /**
   * The page's own state that Escape leaves last (a panel shown alone, kiosk mode): it always sits
   * under menus, dialogs and overlays, even when its state changes while they are open.
   */
  base?: boolean;
}

/** While `open`, registers a layer that Escape closes when it is the topmost one. */
export function useEscapeLayer(
  open: boolean,
  onClose: () => void,
  { blocking = true, base = false }: EscapeLayerOptions = {},
): void {
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (!open) {
      return;
    }
    return push({ close: () => close(), blocking, base });
  }, [open, blocking, base]);
}

/** Number of open blocking layers; shortcuts should do nothing while one is open. */
export function openLayerCount(): number {
  return stack.filter((layer) => layer.blocking).length;
}
