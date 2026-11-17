import { useQuery } from "@tanstack/react-query";
import { lazy, Suspense } from "react";
import type { Provisioned, ResourceKind } from "../../api/generated/shapes";
import { loadArea } from "../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { errorReason } from "../datasources/reasons";
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

/** Whether a change was refused because the resource is managed by files. */
export function isReadOnlyRefusal(error: unknown): boolean {
  return errorReason(error)?.reason === "provisioning.read_only";
}

const Badge = lazy(() =>
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
  return (
    <Suspense fallback={null}>
      <Badge record={record} name={name} compact={compact} />
    </Suspense>
  );
}
