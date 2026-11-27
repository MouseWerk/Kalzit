import type Sigma from "sigma";
import type { GraphPalette } from "../colors";

/**
 * Suggested edges (board Graph082, frame 11 and decision 5): dotted, with an open diamond in the
 * middle and no arrow, a drawing reserved for them, on a 2D canvas beneath the renderer's own
 * canvases. They are no edges of the graph: the renderer, the counts, the rules and the exports
 * never see them.
 */

export interface SuggestionSource {
  /** View node indexes of each suggestion's ends. */
  edges: readonly { source: number; target: number }[];
  show: boolean;
  /** Whether a view node is shown. */
  visible: (node: number) => boolean;
  /** Whether something else is held up, so the suggestions are drawn faint. */
  dimmed: boolean;
  palette: GraphPalette;
}

/** Dash and gap of a suggested edge, in px. */
export const SUGGESTION_DASH: readonly [number, number] = [2, 4];
/** Half the diagonal of the diamond in the middle, in px. */
export const DIAMOND = 4;

/** The diamond in the middle of a suggestion from `a` to `b`, as its four corners. */
export function diamondAt(
  a: { x: number; y: number },
  b: { x: number; y: number },
): [number, number][] {
  const x = (a.x + b.x) / 2;
  const y = (a.y + b.y) / 2;
  return [
    [x, y - DIAMOND],
    [x + DIAMOND, y],
    [x, y + DIAMOND],
    [x - DIAMOND, y],
  ];
}

export function installSuggestions(
  renderer: Sigma,
  host: HTMLElement,
  read: () => SuggestionSource,
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "graph__suggestions";
  canvas.setAttribute("aria-hidden", "true");
  // Beneath the renderer's canvases, so nodes cover the lines' ends.
  host.prepend(canvas);
  const context = canvas.getContext("2d");
  let drew = false;

  const draw = () => {
    if (context === null) return;
    const { edges, show, visible, dimmed, palette } = read();
    const { width, height } = renderer.getDimensions();
    const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    if (
      canvas.width !== Math.round(width * ratio) ||
      canvas.height !== Math.round(height * ratio)
    ) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const wanted = show ? edges.filter((e) => visible(e.source) && visible(e.target)) : [];
    if (wanted.length === 0 && !drew) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    drew = wanted.length > 0;
    if (!drew) return;
    context.globalAlpha = dimmed ? 0.35 : 0.9;
    context.strokeStyle = palette.text;
    context.fillStyle = palette.background;
    context.lineWidth = 1.5;
    for (const edge of wanted) {
      const from = renderer.getNodeDisplayData(String(edge.source));
      const to = renderer.getNodeDisplayData(String(edge.target));
      if (from === undefined || to === undefined) continue;
      const a = renderer.framedGraphToViewport(from);
      const b = renderer.framedGraphToViewport(to);
      context.setLineDash([...SUGGESTION_DASH]);
      context.beginPath();
      context.moveTo(a.x, a.y);
      context.lineTo(b.x, b.y);
      context.stroke();
      context.setLineDash([]);
      context.beginPath();
      const corners = diamondAt(a, b);
      for (const [i, [x, y]] of corners.entries()) {
        if (i === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      }
      context.closePath();
      context.fill();
      context.stroke();
    }
    context.globalAlpha = 1;
  };

  renderer.on("afterRender", draw);
  return () => {
    renderer.off("afterRender", draw);
    canvas.remove();
  };
}
