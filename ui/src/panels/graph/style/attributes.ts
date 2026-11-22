/**
 * The attributes the style layers of the renderer read (sigmaLayers.ts) and the reducers set
 * (drawing.ts). Apart from the layers, so the reducers load without the renderer.
 */

export const BORDER_ATTRIBUTE = "kzBorder";
export const BORDER_COLOR_ATTRIBUTE = "kzBorderColor";
export const ICON_ATTRIBUTE = "kzIcon";
export const ICON_COLOR_ATTRIBUTE = "kzIconColor";
/** `kzBorder`: none, a solid frame, a dashed one. */
export const BORDER_CODE = { none: 0, solid: 1, dashed: 2 } as const;

export const EDGE_PLAIN_ATTRIBUTE = "kzPlain";
export const EDGE_DASH_ATTRIBUTE = "kzDash";
export const EDGE_GAP_ATTRIBUTE = "kzGap";
/** Dash and gap of each line style, in px on screen. */
export const DASH_PATTERN = { dashed: [8, 5], dotted: [2, 4] } as const;
/** The plain color of an edge that is drawn dashed: none, so the gaps stay clear. */
export const CLEAR = "rgba(0, 0, 0, 0)";
