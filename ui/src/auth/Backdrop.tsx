import { useId } from "react";
import { CRYSTAL, ECHO, SCENE, type Scene, TIERS, VIEW } from "./doppelbrechung";
import { registerPicture } from "./signInLight";

/**
 * The picture in the panel of the pages before the app (board Auth.dc.html, frames 3A and 13,
 * "Doppelbrechung"): the lines of a table, a document and a graph run behind a calcite crystal,
 * faint, and stand clear and double inside it. It is drawn here from the numbers in
 * doppelbrechung.ts, in the text color of the theme at a few strengths (auth.css, tokens.css):
 * no gradient, no glow, no accent color, no image file.
 *
 * It stands still. The one movement is the light that runs over the crystal's edges after a
 * sign-in succeeded (signInLight.ts). Screen readers skip it; it is not shown on narrow screens,
 * in the contrast theme and in forced colors, and admins turn it off (`signin.backdrop`).
 * `quiet` draws it fainter, for a server with its own name or logo (frame 3B).
 */
export function Backdrop({ quiet = false }: { quiet?: boolean }) {
  // The id of the crystal's clip must be the page's only one, also with two layouts on a page.
  const clip = `access-art-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div
      ref={registerPicture}
      className={quiet ? "access-bd access-bd--quiet" : "access-bd"}
      aria-hidden="true"
    >
      <svg
        className="access-art"
        viewBox={`${VIEW.x} ${VIEW.y} ${VIEW.width} ${VIEW.height}`}
        focusable="false"
        aria-hidden="true"
      >
        <defs>
          <clipPath id={clip}>
            <path d={CRYSTAL.outline} />
          </clipPath>
        </defs>
        {/* Behind the crystal: faint, and fainter with the distance. */}
        {TIERS.map((tier) => (
          <g key={tier} className={`access-art__behind access-art__behind--${tier}`}>
            <Lines scene={SCENE[tier]} />
          </g>
        ))}
        {/* The crystal's body covers what lies behind it; its top and right face carry a tint. */}
        <path className="access-art__body" d={CRYSTAL.outline} />
        <path className="access-art__face" d={CRYSTAL.top} />
        <path className="access-art__face access-art__face--side" d={CRYSTAL.side} />
        {/* Inside: the same lines once more, clear, and their second image beside them. */}
        <g clipPath={`url(#${clip})`}>
          <g className="access-art__echo" transform={`translate(${ECHO[0]} ${ECHO[1]})`}>
            <Lines scene={SCENE.near} />
          </g>
          <g className="access-art__clear">
            <Lines scene={SCENE.near} />
          </g>
        </g>
        <path className="access-art__ridge" d={CRYSTAL.ridges} />
        <path className="access-art__edge" d={CRYSTAL.outline} />
        {/* The light after a sign-in: a short stroke that travels each path once. */}
        <path className="access-art__light" d={CRYSTAL.outline} pathLength={100} />
        <path className="access-art__light" d={CRYSTAL.ridges} pathLength={100} />
      </svg>
    </div>
  );
}

function Lines({ scene }: { scene: Scene }) {
  return (
    <>
      <path className="access-art__line" d={scene.lines} />
      {scene.nodes === "" ? null : <path className="access-art__node" d={scene.nodes} />}
    </>
  );
}
