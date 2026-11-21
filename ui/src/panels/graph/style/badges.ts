import type Sigma from "sigma";
import type { GraphPalette } from "../colors";
import type { StyledView } from "./apply";

/**
 * Badges: the short text a rule puts on a node ("Top"), drawn as a small pill at the upper right
 * of the node on a 2D canvas above the drawing, after every frame of the renderer. A badge shows
 * whether or not the label of its node does, since it is what the rule wants seen. Its colors
 * are neutral (text color and canvas color, swapped), never the accent.
 */

/** At most this many badges are drawn in a frame, the ones of the largest nodes first. */
export const MAX_BADGES_DRAWN = 400;

const BADGE_FONT_SIZE = 10;
const BADGE_HEIGHT = 14;
const BADGE_PAD = 4;

export interface BadgeSource {
  styled: StyledView | null | undefined;
  /** Whether the view node is shown at all. */
  visible: (node: number) => boolean;
  /** Whether a selection leaves the node out (its badge is then drawn faint). */
  dimmed: (node: number) => boolean;
  palette: GraphPalette;
}

/** A badge as it is drawn: where its pill is, in CSS px of the stage. */
export interface DrawnBadge {
  node: number;
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Where the badges of a frame go: at the upper right of each node, for the nodes inside the
 * stage. Pure, so it is tested without a canvas.
 */
export function badgeBoxes(
  nodes: readonly { node: number; text: string; x: number; y: number; radius: number }[],
  stage: { width: number; height: number },
  measure: (text: string) => number,
): DrawnBadge[] {
  const inside = nodes
    .filter(
      (n) =>
        n.x >= -n.radius &&
        n.y >= -n.radius &&
        n.x <= stage.width + n.radius &&
        n.y <= stage.height + n.radius,
    )
    .sort((a, b) => b.radius - a.radius || a.node - b.node)
    .slice(0, MAX_BADGES_DRAWN);
  return inside.map((n) => {
    const width = Math.ceil(measure(n.text)) + 2 * BADGE_PAD;
    // The corner of the pill sits on the outline of the node, up and to the right of its centre.
    const reach = n.radius * Math.SQRT1_2;
    return {
      node: n.node,
      text: n.text,
      x: n.x + reach - BADGE_PAD,
      y: n.y - reach - BADGE_HEIGHT + BADGE_PAD,
      width,
      height: BADGE_HEIGHT,
    };
  });
}

/**
 * Draws the badges above the renderer's canvases and keeps them in step with it. Returns what
 * removes the canvas again.
 */
export function installBadges(
  renderer: Sigma,
  host: HTMLElement,
  read: () => BadgeSource,
): () => void {
  const canvas = document.createElement("canvas");
  canvas.className = "graph__badges";
  canvas.setAttribute("aria-hidden", "true");
  host.append(canvas);
  const context = canvas.getContext("2d");
  let drew = false;

  const draw = () => {
    if (context === null) return;
    const { styled, visible, dimmed, palette } = read();
    const { width, height } = renderer.getDimensions();
    const ratio = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    if (canvas.width !== Math.round(width * ratio) || canvas.height !== Math.round(height * ratio)) {
      canvas.width = Math.round(width * ratio);
      canvas.height = Math.round(height * ratio);
    }
    const wanted: { node: number; text: string; x: number; y: number; radius: number }[] = [];
    styled?.nodes.forEach((look, node) => {
      if (look?.badge === undefined || !visible(node)) return;
      const data = renderer.getNodeDisplayData(String(node));
      if (data === undefined) return;
      const point = renderer.framedGraphToViewport(data);
      wanted.push({ node, text: look.badge, x: point.x, y: point.y, radius: data.size });
    });
    if (wanted.length === 0 && !drew) return;
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    drew = wanted.length > 0;
    if (!drew) return;
    context.font = `${palette.boldWeight} ${BADGE_FONT_SIZE}px ${palette.font}`;
    context.textBaseline = "middle";
    context.textAlign = "center";
    const boxes = badgeBoxes(wanted, { width, height }, (text) => context.measureText(text).width);
    for (const box of boxes) {
      context.globalAlpha = dimmed(box.node) ? 0.35 : 1;
      context.fillStyle = palette.text;
      context.beginPath();
      context.roundRect(box.x, box.y, box.width, box.height, box.height / 2);
      context.fill();
      context.fillStyle = palette.background;
      context.fillText(box.text, box.x + box.width / 2, box.y + box.height / 2 + 0.5);
    }
    context.globalAlpha = 1;
  };

  renderer.on("afterRender", draw);
  return () => {
    renderer.off("afterRender", draw);
    canvas.remove();
  };
}
