import { useEffect, useRef } from "react";
import {
  crossing,
  hull,
  LINKS,
  LOOP_SECONDS,
  NODES,
  orderedFaces,
  type Phase,
  type Point,
  phaseAt,
  project,
  STILL_PHASE,
  STILL_YAW,
  TURN_RATE,
} from "./crystal";

/** The three colors of the picture, read from the design tokens through the canvas's own style. */
interface Colors {
  ink: string;
  quiet: string;
  beam: string;
}

function readColors(canvas: HTMLCanvasElement): Colors {
  const style = getComputedStyle(canvas);
  return {
    ink: style.color,
    quiet: style.textDecorationColor,
    beam: style.accentColor === "auto" ? style.color : style.accentColor,
  };
}

/** How far behind its head the beam reaches full strength, as a share of the width. */
const LEAD = 0.16;
const STEP = 6;

/** A ray along `y(x)`, drawn as short pieces that fade out behind the head. */
function ray(
  ctx: CanvasRenderingContext2D,
  color: string,
  from: number,
  to: number,
  y: (x: number) => number,
  head: number,
  lead: number,
  strength: number,
) {
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.25;
  const end = Math.min(to, head);
  for (let x = from; x < end; x += STEP) {
    const next = Math.min(end, x + STEP + 0.5);
    const age = Math.min(1, Math.max(0, (head - (x + next) / 2) / lead));
    ctx.globalAlpha = strength * age * age * (3 - 2 * age);
    if (ctx.globalAlpha < 0.01) {
      continue;
    }
    ctx.beginPath();
    ctx.moveTo(x, y(x));
    ctx.lineTo(next, y(next));
    ctx.stroke();
  }
}

function structure(
  ctx: CanvasRenderingContext2D,
  color: string,
  origin: Point,
  side: number,
  shiftY: number,
  alpha: number,
) {
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1;
  ctx.globalAlpha = alpha;
  const at = (node: Point): Point => ({
    x: origin.x + node.x * side,
    y: origin.y + node.y * side + shiftY,
  });
  ctx.beginPath();
  for (const [a, b] of LINKS) {
    const p = at(NODES[a] as Point);
    const q = at(NODES[b] as Point);
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(q.x, q.y);
  }
  ctx.stroke();
  for (const node of NODES) {
    const p = at(node);
    ctx.beginPath();
    ctx.arc(p.x, p.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** One picture of the loop. Sizes are in CSS pixels; the context is scaled to the screen. */
export function drawCrystal(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  seconds: number,
  still: boolean,
  colors: Colors,
) {
  const phase: Phase = phaseAt(still ? STILL_PHASE : (seconds % LOOP_SECONDS) / LOOP_SECONDS);
  const yaw = still ? STILL_YAW : STILL_YAW + seconds * TURN_RATE;
  const center: Point = { x: width / 2, y: height / 2 };
  const breath = still ? 1 : 1 + 0.014 * Math.sin(seconds * 0.9);
  const scale = Math.min(height * 0.36, width * 0.27) * breath;
  const shape = project(yaw, scale, center);
  const outline = hull(shape.points);
  const side = scale * 2.7;
  const origin: Point = { x: center.x - side / 2, y: center.y - side / 2 };
  const parted = phase.split * scale * 0.17;

  ctx.clearRect(0, 0, width, height);
  ctx.lineJoin = "round";
  ctx.lineCap = "butt";

  // The structure, barely there until the light parts.
  structure(ctx, colors.quiet, origin, side, 0, 0.1);

  // The crystal: faint faces, then its edges.
  for (const face of orderedFaces(shape)) {
    ctx.beginPath();
    face.corners.forEach((p, i) => {
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    });
    ctx.closePath();
    ctx.globalAlpha = 0.03 + 0.07 * face.facing;
    ctx.fillStyle = colors.ink;
    ctx.fill();
    ctx.globalAlpha = 0.34;
    ctx.strokeStyle = colors.ink;
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // Behind the crystal the structure shows, twice and a little apart: the two images of a
  // doubly refracting crystal.
  if (phase.reveal > 0.01) {
    ctx.save();
    ctx.beginPath();
    outline.forEach((p, i) => {
      if (i === 0) {
        ctx.moveTo(p.x, p.y);
      } else {
        ctx.lineTo(p.x, p.y);
      }
    });
    ctx.closePath();
    ctx.clip();
    structure(ctx, colors.ink, origin, side, -parted / 2, 0.72 * phase.reveal);
    structure(ctx, colors.quiet, origin, side, parted / 2, 0.56 * phase.reveal);
    ctx.restore();
  }

  ctx.beginPath();
  outline.forEach((p, i) => {
    if (i === 0) {
      ctx.moveTo(p.x, p.y);
    } else {
      ctx.lineTo(p.x, p.y);
    }
  });
  ctx.closePath();
  ctx.globalAlpha = 0.8;
  ctx.strokeStyle = colors.ink;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // The beam: in from the left, apart inside, two parallel rays out.
  if (phase.light > 0.01 && phase.travel > 0) {
    const y0 = center.y - scale * 0.08;
    const span = crossing(outline, y0) ?? { xIn: center.x - scale, xOut: center.x + scale };
    // The beam is drawn from the left, soft at its head, and stays; the still picture shows it whole.
    const lead = width * LEAD;
    const head = still ? width + lead : phase.travel * (width + lead);
    const strength = phase.light;
    ray(ctx, colors.beam, 0, span.xIn, () => y0, head, lead, 0.95 * strength);
    const inside = (x: number) =>
      y0 + parted * ((x - span.xIn) / Math.max(1, span.xOut - span.xIn));
    ray(ctx, colors.beam, span.xIn, span.xOut, () => y0, head, lead, 0.7 * strength);
    ray(ctx, colors.beam, span.xIn, span.xOut, inside, head, lead, 0.7 * strength);
    ray(ctx, colors.beam, span.xOut, width, () => y0, head, lead, 0.8 * strength);
    ray(ctx, colors.ink, span.xOut, width, () => y0 + parted, head, lead, 0.6 * strength);
    if (head < width) {
      ctx.globalAlpha = 0.9 * strength;
      ctx.fillStyle = colors.ink;
      ctx.beginPath();
      ctx.arc(head, y0, 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/**
 * The calcite crystal of the About page, on a canvas: it turns slowly while a thin beam crosses
 * it, splits in two and shows the structure behind. It stops while off screen or in a hidden tab,
 * and shows one still picture with reduced motion. Decoration only; the meaning is in the text.
 */
export function CalciteCrystal() {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d") ?? null;
    if (canvas === null || ctx === null) {
      return;
    }
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const dark = window.matchMedia?.("(prefers-color-scheme: dark)");
    let seconds = 0.4;
    let last: number | undefined;
    let frame: number | undefined;
    let onScreen = true;
    let colors = readColors(canvas);
    let width = 0;
    let height = 0;

    function paint() {
      if (canvas === null || ctx === null || width === 0) {
        return;
      }
      drawCrystal(ctx, width, height, seconds, reduced?.matches === true, colors);
    }

    function tick(now: number) {
      seconds += Math.min(0.1, (now - (last ?? now)) / 1000);
      last = now;
      paint();
      frame = requestAnimationFrame(tick);
    }

    function sync() {
      const run = reduced?.matches !== true && onScreen && !document.hidden;
      if (run && frame === undefined) {
        last = undefined;
        frame = requestAnimationFrame(tick);
      } else if (!run && frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
        last = undefined;
      }
      if (frame === undefined) {
        paint();
      }
    }

    function restyle() {
      if (canvas !== null) {
        colors = readColors(canvas);
        if (frame === undefined) {
          paint();
        }
      }
    }

    function resize() {
      if (canvas === null || ctx === null) {
        return;
      }
      const box = canvas.getBoundingClientRect();
      const ratio = window.devicePixelRatio || 1;
      width = box.width;
      height = box.height;
      canvas.width = Math.max(1, Math.round(width * ratio));
      canvas.height = Math.max(1, Math.round(height * ratio));
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      paint();
    }

    const sizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(resize);
    sizes?.observe(canvas);
    const visible =
      typeof IntersectionObserver === "undefined"
        ? undefined
        : new IntersectionObserver((entries) => {
            onScreen = entries.some((entry) => entry.isIntersecting);
            sync();
          });
    visible?.observe(canvas);
    const themes = new MutationObserver(restyle);
    themes.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    document.addEventListener("visibilitychange", sync);
    reduced?.addEventListener("change", sync);
    dark?.addEventListener("change", restyle);
    resize();
    sync();

    return () => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
      }
      sizes?.disconnect();
      visible?.disconnect();
      themes.disconnect();
      document.removeEventListener("visibilitychange", sync);
      reduced?.removeEventListener("change", sync);
      dark?.removeEventListener("change", restyle);
    };
  }, []);

  return (
    <div className="about-crystal" aria-hidden="true">
      <canvas ref={ref} className="about-crystal__canvas" />
    </div>
  );
}
