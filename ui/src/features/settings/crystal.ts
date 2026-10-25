/**
 * The geometry and timeline of the calcite crystal on the About page (CalciteCrystal.tsx): a
 * rhombohedron with calcite's 78 degree face angle, turning slowly, and a loop in which a thin
 * beam enters from the left, splits in two inside (double refraction) and shows the structure
 * behind the crystal. Pure functions, so the picture can be tested without a canvas.
 */

export type Vec3 = readonly [number, number, number];
export interface Point {
  x: number;
  y: number;
}

/** Seconds of one pass of the beam. */
export const LOOP_SECONDS = 11;
/** Radians per second the crystal turns about its long axis: one turn in about a minute. */
export const TURN_RATE = 0.105;
/** The moment of the loop (0..1) that the static picture for reduced motion shows. */
export const STILL_PHASE = 0.62;
export const STILL_YAW = 0.6;

// Calcite's cleavage angle is 78.08 degrees. A cube stretched by k along its body diagonal has
// face angle acos((k^2 - 1) / (k^2 + 2)), so k follows from the angle.
const FACE_ANGLE = (78.08 * Math.PI) / 180;
const STRETCH = Math.sqrt((1 + 2 * Math.cos(FACE_ANGLE)) / (1 - Math.cos(FACE_ANGLE)));
const TILT = -0.32;

/** Cube corners, indexed by their three bits (x, y, z). */
const CORNERS: Vec3[] = Array.from({ length: 8 }, (_, i) => [
  i & 1 ? 1 : -1,
  i & 2 ? 1 : -1,
  i & 4 ? 1 : -1,
]);

/** The six faces as corner indices in order around the face. */
export const FACES: readonly (readonly [number, number, number, number])[] = [
  [0, 1, 3, 2],
  [4, 5, 7, 6],
  [0, 1, 5, 4],
  [2, 3, 7, 6],
  [0, 2, 6, 4],
  [1, 3, 7, 5],
];

/** The twelve edges, pairs of corners one bit apart. */
export const EDGES: readonly (readonly [number, number])[] = CORNERS.flatMap((_, a) =>
  [1, 2, 4].map((bit) => [a, a ^ bit] as const).filter(([x, y]) => x < y),
);

/** A corner stretched along the body diagonal and stood upright (the diagonal points up). */
function rhombohedron(corner: Vec3): Vec3 {
  const [x, y, z] = corner;
  const along = (x + y + z) / 3;
  const stretched: Vec3 = [
    x + (STRETCH - 1) * along,
    y + (STRETCH - 1) * along,
    z + (STRETCH - 1) * along,
  ];
  // Turn the diagonal (1,1,1) onto the y axis: 45 degrees about z, then about x.
  const [sx, sy, sz] = stretched;
  const a = Math.PI / 4;
  const rx = sx * Math.cos(a) - sy * Math.sin(a);
  const ry = sx * Math.sin(a) + sy * Math.cos(a);
  const b = Math.atan2(1, Math.SQRT2);
  const ry2 = ry * Math.cos(b) + sz * Math.sin(b);
  const rz2 = -ry * Math.sin(b) + sz * Math.cos(b);
  return [rx, ry2, rz2];
}

/** The eight corners of the upright crystal, before the turn. */
export const SHAPE: Vec3[] = CORNERS.map(rhombohedron);
const SIZE = Math.max(...SHAPE.map(([x, y, z]) => Math.hypot(x, y, z)));

export interface Projected {
  points: Point[];
  /** Depth of each corner after the turn; larger is nearer. */
  depth: number[];
}

/** The corners turned by `yaw` about the vertical axis, tilted toward the viewer, scaled. */
export function project(yaw: number, scale: number, center: Point): Projected {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const ct = Math.cos(TILT);
  const st = Math.sin(TILT);
  const points: Point[] = [];
  const depth: number[] = [];
  for (const [x, y, z] of SHAPE) {
    const tx = x * cy + z * sy;
    const tz = -x * sy + z * cy;
    const ty = y * ct - tz * st;
    const tz2 = y * st + tz * ct;
    points.push({ x: center.x + (tx / SIZE) * scale, y: center.y - (ty / SIZE) * scale });
    depth.push(tz2);
  }
  return { points, depth };
}

/** Faces ordered far to near, with how much each faces the viewer (0..1) for its shading. */
export function orderedFaces(shape: Projected): { corners: Point[]; facing: number }[] {
  return FACES.map((face) => {
    const corners = face.map((i) => shape.points[i] as Point);
    const z = face.reduce((sum, i) => sum + (shape.depth[i] as number), 0) / 4;
    const [a, b, c] = corners as [Point, Point, Point];
    const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    return { corners, z, cross };
  })
    .sort((p, q) => p.z - q.z)
    .map(({ corners, cross }) => ({ corners, facing: Math.min(1, Math.abs(cross) / 9000) }));
}

/** The convex hull of the projected corners, counter-clockwise (the crystal's outline). */
export function hull(points: readonly Point[]): Point[] {
  const sorted = [...points].sort((p, q) => p.x - q.x || p.y - q.y);
  const cross = (o: Point, a: Point, b: Point) =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const build = (list: Point[]) => {
    const out: Point[] = [];
    for (const p of list) {
      while (
        out.length >= 2 &&
        cross(out[out.length - 2] as Point, out[out.length - 1] as Point, p) <= 0
      ) {
        out.pop();
      }
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...build(sorted), ...build([...sorted].reverse())];
}

/** Where the horizontal line `y` enters and leaves a convex outline; null when it misses. */
export function crossing(
  outline: readonly Point[],
  y: number,
): { xIn: number; xOut: number } | null {
  const xs: number[] = [];
  for (let i = 0; i < outline.length; i += 1) {
    const a = outline[i] as Point;
    const b = outline[(i + 1) % outline.length] as Point;
    if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
      xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
    }
  }
  if (xs.length < 2) {
    return null;
  }
  return { xIn: Math.min(...xs), xOut: Math.max(...xs) };
}

export function smoothstep(from: number, to: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - from) / (to - from)));
  return t * t * (3 - 2 * t);
}

export interface Phase {
  /** How far the beam has travelled, 0 (not started) to 1 (across the picture). */
  travel: number;
  /** How much the beam is shown at all, 0..1 (it fades at the end of the loop). */
  light: number;
  /** How far the two rays have parted, 0..1. */
  split: number;
  /** How much of the structure behind the crystal is shown, 0..1. */
  reveal: number;
}

/** The beam's state at a moment `phase` (0..1) of the loop. */
export function phaseAt(phase: number): Phase {
  const travel = smoothstep(0.04, 0.34, phase);
  const split = smoothstep(0.24, 0.46, phase) * (1 - smoothstep(0.84, 0.97, phase));
  return {
    travel,
    light: 1 - smoothstep(0.86, 0.98, phase),
    split,
    reveal: smoothstep(0.26, 0.5, phase) * (1 - smoothstep(0.82, 0.96, phase)),
  };
}

/** The structure behind the crystal: a small graph in a 0..1 square, fixed. */
export const NODES: readonly Point[] = [
  { x: 0.1, y: 0.28 },
  { x: 0.26, y: 0.62 },
  { x: 0.34, y: 0.18 },
  { x: 0.5, y: 0.5 },
  { x: 0.62, y: 0.12 },
  { x: 0.68, y: 0.78 },
  { x: 0.84, y: 0.4 },
  { x: 0.92, y: 0.7 },
  { x: 0.44, y: 0.88 },
  { x: 0.16, y: 0.9 },
];

export const LINKS: readonly (readonly [number, number])[] = [
  [0, 1],
  [0, 2],
  [1, 3],
  [2, 3],
  [2, 4],
  [3, 5],
  [3, 6],
  [4, 6],
  [5, 7],
  [6, 7],
  [3, 8],
  [1, 9],
  [8, 5],
  [9, 8],
];
