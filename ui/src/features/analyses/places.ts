import { folderTrail } from "../../components/Breadcrumbs";
import type { Translate } from "../../i18n/i18n";
import type { Folder } from "../dashboards/api";

/**
 * Where an analysis can be kept: the organization's folders (and its top level) and the team
 * spaces with their folders, as the save dialog's "Location" and the list's tree show them.
 */
export interface Place {
  /** `null` is the top level of the organization. */
  id: string | null;
  /** The folder's path from the top, "Sales / Orders". */
  label: string;
}

export interface PlaceGroup {
  /** "Organization", or the team space's team. */
  label: string;
  places: Place[];
}

/** The team space a folder lies in, or undefined outside every team space. */
export function teamSpaceOf(folders: readonly Folder[], id: string | null): Folder | undefined {
  return folderTrail(folders, id).find((folder) => folder.teamSpace);
}

/** A folder's path as one line, "Sales / Orders"; the top level has its own name. */
export function placeLabel(t: Translate, folders: readonly Folder[], id: string | null): string {
  const trail = folderTrail(folders, id);
  return trail.length === 0
    ? t("analyses.place.top")
    : trail.map((folder) => folder.name).join(" / ");
}

/**
 * The places the caller may save into, grouped: the organization first, then each team space.
 * Folders without the right to write into them are left out; `canTop` says whether the top level
 * is allowed (the org-wide `analyses:write`).
 */
export function placeGroups(
  t: Translate,
  folders: readonly Folder[],
  canTop: boolean,
): PlaceGroup[] {
  const org: Place[] = canTop ? [{ id: null, label: t("analyses.place.top") }] : [];
  const spaces = new Map<string, PlaceGroup>();
  for (const folder of folders) {
    if (folder.access !== undefined && !folder.access.write) {
      continue;
    }
    const place = { id: folder.id, label: placeLabel(t, folders, folder.id) };
    const space = teamSpaceOf(folders, folder.id);
    if (space === undefined) {
      org.push(place);
      continue;
    }
    const group = spaces.get(space.id) ?? {
      label: t("analyses.place.teamGroup", { team: space.ownerTeam?.name ?? space.name }),
      places: [],
    };
    group.places.push(place);
    spaces.set(space.id, group);
  }
  const byLabel = (a: Place, b: Place) =>
    a.id === null ? -1 : b.id === null ? 1 : a.label.localeCompare(b.label);
  const groups = [...spaces.values()].map((group) => ({
    ...group,
    places: group.places.sort(byLabel),
  }));
  groups.sort((a, b) => a.label.localeCompare(b.label));
  return [
    ...(org.length === 0
      ? []
      : [{ label: t("analyses.place.orgGroup"), places: org.sort(byLabel) }]),
    ...groups,
  ];
}

/** Who will see an analysis kept at `id`: a team space's team, a restricted folder, or all. */
export function visibilityHint(
  t: Translate,
  folders: readonly Folder[],
  id: string | null,
): string {
  const space = teamSpaceOf(folders, id);
  if (space !== undefined) {
    return t("analyses.place.visibleTeam", { team: space.ownerTeam?.name ?? space.name });
  }
  const trail = folderTrail(folders, id);
  const restricted = trail.find((folder) => folder.restricted);
  if (restricted !== undefined) {
    return t("analyses.place.visibleRestricted", { folder: restricted.name });
  }
  return t("analyses.place.visibleAll");
}
