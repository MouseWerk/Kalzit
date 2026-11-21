import type { GraphModel } from "./model";
import { NODE_SHAPES, type NodeShape, ownEntry } from "./options";

/**
 * The shape of a node, a second cue next to its color: color alone fails readers who do not tell
 * the palette's colors apart, and with forced colors (Windows high contrast) the eight palette
 * colors become three system colors (graph.css), so the shape is what still tells labels apart.
 * Each label keeps one shape: the one the panel gives it, or one by its place in the result's
 * labels, as its color is (labels the explorer adds come after the others, so a label never
 * changes its shape).
 *
 * The shape by place is chosen so that color and shape together stay apart: the first three
 * labels take circle, square and diamond; the first eight differ in system color and shape with
 * forced colors (palette colors 1, 4 and 7 share one system color, 2, 5 and 8 another, 3 and 6
 * the third); and the 24 first labels each have a pair of palette color and shape of their own.
 */

export { NODE_SHAPES, type NodeShape };

/**
 * Every shape the renderer draws: the three a label takes, and the two more a style rule may set
 * (style/schema.ts). Labels keep cycling through the first three, so no label changes its shape.
 */
export type DrawnShape = NodeShape | "triangle" | "hexagon";

/** The shape the label checks count with: a triangle and a hexagon lie inside their circle. */
export function boundingShape(shape: DrawnShape): NodeShape {
  return shape === "square" || shape === "diamond" ? shape : "circle";
}

/** The shape after `shape` among the label shapes: a second cue where a color repeats. */
export function nextShape(shape: DrawnShape): NodeShape {
  const at = NODE_SHAPES.indexOf(boundingShape(shape));
  return NODE_SHAPES[(at + 1) % NODE_SHAPES.length] as NodeShape;
}

/**
 * How large each shape is drawn for a node of size 1, so the three cover about the same area:
 * the renderer's square fills the box around the node's circle and its diamond touches it.
 */
export const SHAPE_SCALE: Record<DrawnShape, number> = {
  circle: 1,
  square: 0.89,
  diamond: 1.25,
  triangle: 1.4,
  hexagon: 1.1,
};

/** The shape a label takes by its place in the result's labels (see above). */
export function shapeByPlace(label: number): NodeShape {
  const tone = label % 8;
  const round = Math.floor(label / 8);
  return NODE_SHAPES[(tone + Math.floor(tone / 3) + 2 * round) % NODE_SHAPES.length] as NodeShape;
}

/** The shape of a label: its own when the panel gives it one, else by its place. */
export function labelShapeOf(
  model: Pick<GraphModel, "labels">,
  labelShapes: Readonly<Record<string, NodeShape>>,
): (label: number) => NodeShape {
  return (label) => {
    if (label < 0) return "circle";
    return ownEntry(labelShapes, model.labels[label] ?? "") ?? shapeByPlace(label);
  };
}
