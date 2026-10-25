import { writePreference } from "../../lib/storage";

/** The source Explore opens with: the one last picked there, or one opened from another page. */
export const LAST_DATASOURCE_KEY = "kalzit.explore.datasource";

/** Makes Explore open with this source the next time it loads. */
export function openWithSource(id: string): void {
  writePreference(LAST_DATASOURCE_KEY, id);
}
