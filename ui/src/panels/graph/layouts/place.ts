import { hierarchyLayout } from "../layoutEngine";
import type { LayoutGuide, LayoutRequest } from "../layoutProtocol";
import { circularLayout } from "./circular";
import { coordinateLayout } from "./coordinates";
import { gridLayout } from "./grid";
import { radialLayout } from "./radial";
import type { Work } from "./shared";
import { timelineLayout } from "./timeline";

export interface Placed {
  positions: Float32Array;
  guides: LayoutGuide[];
  /** Hierarchy: edges reversed to break cycles; 0 for the others. */
  reversed: number;
}

/**
 * Runs a layout that answers once, in one piece: every layout but the force layout, which settles
 * step by step (ForceLayout). The layout worker calls it, and so does the page for small graphs
 * where no worker is available. The same request always gives the same answer.
 */
export function placeLayout(request: LayoutRequest, work?: Work): Placed {
  switch (request.mode) {
    case "hierarchy": {
      const options = { direction: request.direction ?? "down", ...(work ? { work } : {}) };
      const result = hierarchyLayout(request, options);
      return { positions: result.positions, guides: [], reversed: result.reversed };
    }
    case "radial":
      return { ...radialLayout(request, work), reversed: 0 };
    case "circular":
      return { ...circularLayout(request), reversed: 0 };
    case "grid":
      return { ...gridLayout(request), reversed: 0 };
    case "coordinates":
      return { ...coordinateLayout(request), reversed: 0 };
    case "timeline":
      return { ...timelineLayout(request), reversed: 0 };
    case "force":
      throw new Error("The force layout settles step by step (ForceLayout)");
  }
}
