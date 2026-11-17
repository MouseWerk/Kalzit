import { useQuery } from "@tanstack/react-query";
import type { Provisioned, ResourceKind } from "../../api/generated/shapes";
import { LazyPiece, pieceSource } from "../../components/LazyPiece";
import { loadArea } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { provisionedQuery } from "./api";

/*
 * "Aus Dateien verwaltet" for the pages of the resources themselves (board Provisioning.dc.html,
 * frames 5 and 6). This module is small and stays with those pages; the badge with its popover
 * and its texts loads when a managed resource is actually shown.
 */

/**
 * The provisioning record of a resource, for people who may read the sets (`provisioning:read`).
 * Everyone else learns of it from the server's refusal when they change the resource.
 */
export function useManaged(kind: ResourceKind, resourceId: string | undefined) {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const records = useQuery({
    ...provisionedQuery(org?.id ?? ""),
    enabled: org !== undefined && permissions.has("provisioning:read"),
  });
  return resourceId === undefined
    ? undefined
    : records.data?.find((record) => record.kind === kind && record.resourceId === resourceId);
}

/** Every provisioning record of one kind by resource id, for lists. */
export function useManagedOf(kind: ResourceKind): ReadonlyMap<string, Provisioned> {
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const records = useQuery({
    ...provisionedQuery(org?.id ?? ""),
    enabled: org !== undefined && permissions.has("provisioning:read"),
  });
  return new Map(
    (records.data ?? [])
      .filter((record) => record.kind === kind)
      .map((record) => [record.resourceId, record]),
  );
}

/** Managed and not unlocked: the UI may not change it, the server refuses. */
export function isLocked(record: Provisioned | undefined): boolean {
  return record !== undefined && record.unlockedAt === null && !record.missing;
}

// Its own boundary: when the badge's code or texts fail to load, the page stays and shows no
// badge; the server still refuses changes with the reason.
const BADGE = pieceSource<{ record: Provisioned; name: string; compact: boolean }>(() =>
  loadArea("provisioning")
    .then(() => import("./ManagedBadge"))
    .then((module) => ({ default: module.ManagedBadge })),
);

/**
 * The badge of a managed resource; nothing for one the files do not manage. `compact` is the
 * word alone for a list row, without the popover.
 */
export function ManagedBadge({
  record,
  name,
  compact = false,
}: {
  record: Provisioned | undefined;
  /** The resource's name, for the unlock question. */
  name: string;
  compact?: boolean;
}) {
  if (record === undefined) {
    return null;
  }
  return <LazyPiece source={BADGE} props={{ record, name, compact }} />;
}
