import { useEffect, useState } from "react";
import { loadOutlines, type OutlinePaths } from "./outlines";

/**
 * The bundled outlines while a map wants them: the world (land, lakes, countries) and, when
 * `regions`, the first-level regions. Loaded once per file and kept; a file that does not load
 * leaves its part out (the data never waits for the outlines).
 */
export function useOutlines(wanted: boolean, regions: boolean) {
  const [world, setWorld] = useState<OutlinePaths | null>(null);
  const [regionPaths, setRegionPaths] = useState<OutlinePaths | null>(null);
  useEffect(() => {
    if (!wanted) return;
    let current = true;
    loadOutlines("world").then(
      (paths) => {
        if (current) setWorld(paths);
      },
      // Without outlines the graticule still carries the points.
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted]);
  useEffect(() => {
    if (!wanted || !regions) return;
    let current = true;
    loadOutlines("regions").then(
      (paths) => {
        if (current) setRegionPaths(paths);
      },
      () => undefined,
    );
    return () => {
      current = false;
    };
  }, [wanted, regions]);
  return { world: wanted ? world : null, regions: wanted && regions ? regionPaths : null };
}
