import type { CanvasHandle } from "../SigmaCanvas";

/**
 * Calls `onFrame` once per animation frame after the canvas drew one (several frames drawn in
 * between count once), until the returned function is called. Decoration over the canvas (the
 * minimap, the marks of pinned nodes) follows it this way.
 */
export function followCanvas(handle: CanvasHandle, onFrame: () => void): () => void {
  let waiting = 0;
  const request = () => {
    if (waiting !== 0) return;
    waiting = requestAnimationFrame(() => {
      waiting = 0;
      onFrame();
    });
  };
  const stop = handle.subscribe(request);
  request();
  return () => {
    cancelAnimationFrame(waiting);
    stop();
  };
}
