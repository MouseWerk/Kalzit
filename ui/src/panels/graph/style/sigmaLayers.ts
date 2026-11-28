import type { EdgeLayer, FragmentLayer, SDFShape } from "sigma/rendering";
import { layerDashed, layerPlain } from "sigma/rendering";
import {
  BORDER_ATTRIBUTE,
  BORDER_COLOR_ATTRIBUTE,
  EDGE_DASH_ATTRIBUTE,
  EDGE_GAP_ATTRIBUTE,
  EDGE_PLAIN_ATTRIBUTE,
  ICON_ATTRIBUTE,
  ICON_COLOR_ATTRIBUTE,
} from "./attributes";
import { atlasState } from "./iconAtlas";

/**
 * What style rules add to the renderer: for nodes a frame (solid or dashed, in the text color),
 * an icon read from the atlas texture and the hexagon as a fifth shape; for edges a dashed or
 * dotted line. Each is a layer of the node or edge program, drawn in the same pass as the fill,
 * so 20,000 nodes with icons cost no extra draw call.
 */

// The type names of WebGL as numbers: the constants are not there where the tests run.
const GL_FLOAT = 0x1406;
const GL_UNSIGNED_BYTE = 0x1401;

/** The width of a frame on screen, in px. */
const BORDER_WIDTH = 2;

/**
 * The frame of a node, just inside its outline: solid or dashed, always in the color handed in
 * (the text color). It never stands for selection, which draws no frame at all.
 */
export function layerRuleBorder(): FragmentLayer {
  // language=GLSL
  const glsl = /*glsl*/ `
vec4 layer_kzBorder(float v_kzBorder, vec4 v_kzBorderColor) {
  if (v_kzBorder < 0.5) return vec4(0.0);
  // At most a third of the node, so a small node keeps its fill.
  float width = min(${BORDER_WIDTH.toFixed(1)} * context.pixelToUV, 0.33);
  float ring = smoothstep(-width - context.aaWidth, -width + context.aaWidth, context.sdf);
  if (v_kzBorder > 1.5) {
    // Dashes of about nine pixels along the outline, by the angle around the centre.
    float turns = atan(context.uv.y, context.uv.x) / 6.2831853 + 0.5;
    float dashes = max(6.0, floor(context.pixelSize * 3.1415927 / 9.0));
    float phase = fract(turns * dashes);
    ring *= smoothstep(0.0, 0.08, phase) * (1.0 - smoothstep(0.55, 0.63, phase));
  }
  return vec4(v_kzBorderColor.rgb, v_kzBorderColor.a * ring);
}
`;
  return {
    name: "kzBorder",
    uniforms: [],
    attributes: [
      { name: BORDER_ATTRIBUTE, size: 1, type: GL_FLOAT, source: BORDER_ATTRIBUTE },
      {
        name: BORDER_COLOR_ATTRIBUTE,
        size: 4,
        type: GL_UNSIGNED_BYTE,
        normalized: true,
        source: BORDER_COLOR_ATTRIBUTE,
      },
    ],
    glsl,
  };
}

/** The texture unit of the icon atlas: above the units the renderer uses itself (0 to 7). */
const ICON_TEXTURE_UNIT = 8;
const ICON_SAMPLER = "u_kzIconAtlas";

/**
 * The icon of a node, centred in it and as large as fits inside its shape, in the color handed
 * in. The texture is the icon atlas of the page (iconAtlas.ts), uploaded again whenever an icon
 * was added to it.
 */
export function layerRuleIcon(): FragmentLayer {
  // language=GLSL
  const glsl = /*glsl*/ `
#ifdef PICKING_MODE
// The picking pass needs only the shape, so it never names the atlas: the renderer sets the
// sampler for the visible pass only, and a sampler left at unit 0 would read the picking texture
// the pass draws into, a feedback loop the driver refuses. A sampler handed to a function counts
// as read, so the call itself is replaced.
#define layer_kzIcon(icon, color, atlas) vec4(0.0)
#else
vec4 layer_kzIcon(vec4 v_kzIcon, vec4 v_kzIconColor, sampler2D ${ICON_SAMPLER}) {
  if (v_kzIcon.z <= 0.0) return vec4(0.0);
  // The square inside the inner circle of the shape, with a little air around it.
  float reach = 0.62 * context.inradiusFactor * context.shapeSize;
  vec2 p = context.uv / reach;
  if (abs(p.x) > 1.0 || abs(p.y) > 1.0) return vec4(0.0);
  // The first row of the texture is the top of the icon; the y axis of the node points up.
  vec2 cell = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5);
  float coverage = texture(${ICON_SAMPLER}, v_kzIcon.xy + cell * v_kzIcon.zw).a;
  return vec4(v_kzIconColor.rgb, v_kzIconColor.a * coverage);
}
#endif
`;
  return {
    name: "kzIcon",
    uniforms: [{ name: ICON_SAMPLER, type: "sampler2D" }],
    attributes: [
      { name: ICON_ATTRIBUTE, size: 4, type: GL_FLOAT, source: ICON_ATTRIBUTE },
      {
        name: ICON_COLOR_ATTRIBUTE,
        size: 4,
        type: GL_UNSIGNED_BYTE,
        normalized: true,
        source: ICON_COLOR_ATTRIBUTE,
      },
    ],
    glsl,
    lifecycle: ({ gl, getUniformLocation }) => {
      let texture: WebGLTexture | null = null;
      let uploaded = -1;
      const bind = () => {
        gl.activeTexture(gl.TEXTURE0 + ICON_TEXTURE_UNIT);
        gl.bindTexture(gl.TEXTURE_2D, texture);
      };
      return {
        init() {
          texture = gl.createTexture();
          bind();
          // One clear texel until the first icon is drawn, so the sampler always has a texture.
          gl.texImage2D(
            gl.TEXTURE_2D,
            0,
            gl.ALPHA,
            1,
            1,
            0,
            gl.ALPHA,
            gl.UNSIGNED_BYTE,
            new Uint8Array([0]),
          );
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          gl.activeTexture(gl.TEXTURE0);
        },
        beforeRender() {
          bind();
          const { canvas, version } = atlasState();
          if (canvas !== null && version !== uploaded && version > 0) {
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.ALPHA, gl.ALPHA, gl.UNSIGNED_BYTE, canvas);
            // Small nodes read a smaller level, so a 64 px icon drawn at 10 px does not flicker.
            gl.generateMipmap(gl.TEXTURE_2D);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
            uploaded = version;
          }
          gl.uniform1i(getUniformLocation(ICON_SAMPLER), ICON_TEXTURE_UNIT);
          gl.activeTexture(gl.TEXTURE0);
        },
        kill() {
          gl.deleteTexture(texture);
          texture = null;
        },
      };
    },
  };
}

/**
 * A regular hexagon with a flat top, the fifth node shape. `size` is the distance from the
 * centre to a corner, as for the shapes the renderer brings.
 */
export function sdfHexagon(): SDFShape {
  // language=GLSL
  const glsl = /*glsl*/ `
float sdf_hexagon(vec2 uv, float size) {
  const vec3 k = vec3(-0.866025404, 0.5, 0.577350269);
  // The distance from the centre to an edge.
  float r = size * 0.866025404;
  vec2 p = abs(uv);
  p -= 2.0 * min(dot(k.xy, p), 0.0) * k.xy;
  p -= vec2(clamp(p.x, -k.z * r, k.z * r), r);
  return length(p) * sign(p.y);
}
`;
  return { name: "hexagon", glsl, uniforms: [], inradiusFactor: 0.866025404 };
}

/**
 * The layers of an edge: its plain color, and dashes for the edges a rule draws dashed or
 * dotted. A solid edge has no dash size, which leaves the dashed layer clear; a dashed one has
 * no plain color. Arrow heads stay whole.
 */
export function ruleEdgeLayers(): EdgeLayer[] {
  return [
    layerPlain({ color: { attribute: EDGE_PLAIN_ATTRIBUTE } }),
    layerDashed({
      dashSize: { attribute: EDGE_DASH_ATTRIBUTE, default: 0, mode: "pixels" },
      gapSize: { attribute: EDGE_GAP_ATTRIBUTE, default: 0, mode: "pixels" },
      solidExtremities: true,
    }),
  ];
}
