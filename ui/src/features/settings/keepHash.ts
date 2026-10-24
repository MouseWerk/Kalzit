import type { ParsedLocation } from "@tanstack/react-router";

/** A link to one setting (`#key`) keeps pointing at it through a redirect. */
export function keepHash(location: ParsedLocation): { hash?: string } {
  return location.hash === "" ? {} : { hash: location.hash };
}
