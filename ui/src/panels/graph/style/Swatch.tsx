import { useIcons } from "./icons/load";
import type { EdgeDash, RuleBorder, RuleShape, StyleColor } from "./schema";
import "./style.css";

/**
 * Small drawings of what a rule sets, for the list, the legend and the pickers: a node in its
 * shape and color (with its frame), an icon of the set, an edge in its line style. Colors come
 * from classes on the theme's tokens (style.css); with forced colors they take the text color,
 * and shape, frame, icon and line style still tell rules apart. Never read out: the text next to
 * them says the same in words.
 */

const SHAPE_PATHS: Record<RuleShape, string> = {
  circle: "M10 1.2a8.8 8.8 0 1 1 0 17.6a8.8 8.8 0 1 1 0-17.6Z",
  square: "M2.2 2.2h15.6v15.6H2.2Z",
  diamond: "M10 0.8 19.2 10 10 19.2 0.8 10Z",
  triangle: "M10 1.5 18.8 17.5H1.2Z",
  hexagon: "M5.2 1.7h9.6L19.6 10l-4.8 8.3H5.2L0.4 10Z",
};

export function toneClass(color: StyleColor | undefined): string {
  return `graph-style__tone graph-style__tone--${color ?? "basis"}`;
}

export function NodeSwatch({
  shape = "circle",
  color,
  border = "none",
}: {
  shape?: RuleShape | undefined;
  color?: StyleColor | undefined;
  border?: RuleBorder | undefined;
}) {
  return (
    <svg
      className={`graph-style__swatch ${toneClass(color)}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      data-shape={shape}
    >
      <path className="graph-style__fill" d={SHAPE_PATHS[shape]} />
      {border === "none" ? null : (
        <path
          className={`graph-style__frame${border === "dashed" ? " graph-style__frame--dashed" : ""}`}
          d={SHAPE_PATHS[shape]}
        />
      )}
    </svg>
  );
}

export function EdgeSwatch({
  color,
  dash = "solid",
  width = 2,
}: {
  color?: StyleColor | undefined;
  dash?: EdgeDash | undefined;
  width?: number | undefined;
}) {
  return (
    <svg
      className={`graph-style__swatch graph-style__swatch--edge ${toneClass(color)}`}
      viewBox="0 0 20 20"
      aria-hidden="true"
      focusable="false"
      data-dash={dash}
    >
      <path
        className={`graph-style__line graph-style__line--${dash} graph-style__line--w${Math.min(4, Math.max(1, Math.round(width / 2)))}`}
        d="M1 10H19"
      />
    </svg>
  );
}

/** An icon of the set at text size; nothing while the set loads or for a name it lacks. */
export function IconGlyph({ name }: { name: string }) {
  const set = useIcons();
  const icon = set?.iconOf(name);
  if (icon === undefined) return null;
  return (
    <svg
      className="graph-style__icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      focusable="false"
      data-icon={name}
    >
      <path d={icon.d} />
    </svg>
  );
}
