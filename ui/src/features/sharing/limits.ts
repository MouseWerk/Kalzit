import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { isApiError, isRecord, request } from "../../api/client";
import { hasMessage, type Translate } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import { SHARING_KEY } from "./api";
import { bytesText, DEFAULT_MAX_EXPIRY_DAYS, defaultExpiryDays, expiryChoices } from "./model";

/**
 * Why nothing public can be made here, in the order people can act on it: the server's switch,
 * the organization's, a switch somewhere (the server refused, and it does not say which), or
 * the missing permission.
 */
export type PublicBlock = "server" | "org" | "off" | "permission";

export interface SharingLimits {
  /** Undefined when public sharing is open to the caller, as far as the UI can tell. */
  block: PublicBlock | undefined;
  /**
   * The longest expiry in days, once the server said it: in its limits, or in a refusal.
   * Undefined until then; the UI states no limit it does not know.
   */
  maxExpiryDays: number | undefined;
  /** The largest snapshot in bytes, once the server said it. */
  snapshotMaxBytes: number | undefined;
}

interface ServerLimits {
  serverPublic: boolean;
  orgPublic: boolean;
  maxExpiryDays: number;
  snapshotMaxBytes: number;
}

/**
 * The switches and limits in effect (`GET /orgs/{orgId}/sharing`, readable by every member).
 * Null from a server that does not have the route yet: the dialog then learns from refusals.
 */
async function fetchLimits(orgId: string, signal: AbortSignal): Promise<ServerLimits | null> {
  let answer: unknown;
  try {
    answer = await request("GET", `/api/orgs/${encodeURIComponent(orgId)}/sharing`, undefined, {
      signal,
    });
  } catch (error) {
    if (isApiError(error, "not_found")) return null;
    throw error;
  }
  if (
    !isRecord(answer) ||
    typeof answer.serverPublic !== "boolean" ||
    typeof answer.orgPublic !== "boolean" ||
    typeof answer.maxExpiryDays !== "number" ||
    typeof answer.snapshotMaxBytes !== "number"
  ) {
    return null;
  }
  return {
    serverPublic: answer.serverPublic,
    orgPublic: answer.orgPublic,
    maxExpiryDays: answer.maxExpiryDays,
    snapshotMaxBytes: answer.snapshotMaxBytes,
  };
}

export interface Refusals {
  /** The server said a sharing switch is off. */
  publicOff?: boolean;
  /** The longest expiry a refusal named. */
  maxDays?: number | undefined;
}

/**
 * The sharing switches and limits for the dialogs, from the server's own answer; what a refusal
 * said fills in where that answer is missing. Only for showing what is possible: the server
 * checks every request.
 */
export function useSharingLimits(orgId: string, refusals: Refusals = {}): SharingLimits {
  const permissions = useOrgPermissions();
  const limits = useQuery({
    queryKey: [SHARING_KEY, "limits", orgId],
    queryFn: ({ signal }) => fetchLimits(orgId, signal),
    enabled: orgId !== "",
    staleTime: 30_000,
    retry: false,
  });
  const known = limits.data ?? undefined;
  let block: PublicBlock | undefined;
  if (known?.serverPublic === false) {
    block = "server";
  } else if (known?.orgPublic === false) {
    block = "org";
  } else if (refusals.publicOff === true) {
    block = "off";
  } else if (permissions.loaded && !permissions.has("dashboards:public")) {
    block = "permission";
  }
  return {
    block,
    maxExpiryDays: known?.maxExpiryDays ?? refusals.maxDays,
    snapshotMaxBytes: known?.snapshotMaxBytes,
  };
}

/**
 * The expiry chosen in a form, in days. Nothing is fixed before the person picks: until then it
 * is the default within the longest expiry known now, so limits that arrive later (or with a
 * refusal) rebuild the choices instead of leaving one the server would refuse.
 */
export function useExpiryChoice(limits: SharingLimits): {
  days: number;
  choices: number[];
  setDays: (days: number) => void;
} {
  const [picked, setPicked] = useState<number | null>(null);
  const max = limits.maxExpiryDays ?? DEFAULT_MAX_EXPIRY_DAYS;
  const choices = expiryChoices(max);
  const days = picked !== null && choices.includes(picked) ? picked : defaultExpiryDays(max);
  return { days, choices, setDays: setPicked };
}

/** Whether the server refused because a sharing switch is off. */
export function isPublicOff(error: unknown): boolean {
  return errorReason(error)?.reason === "sharing.public_off";
}

/** The longest expiry in days the server named in its refusal, if it did. */
export function refusedMaxDays(error: unknown): number | undefined {
  const reason = errorReason(error);
  const days = Number(reason?.params?.maxDays);
  return reason?.reason === "sharing.expiry_invalid" && Number.isFinite(days) && days > 0
    ? days
    : undefined;
}

/**
 * The text of a failed sharing request: the reason in this area's words (docs/api/sharing.md,
 * "Reasons"), else the shared texts.
 */
export function sharingErrorText(t: Translate, error: unknown, language: string): string {
  const reason = errorReason(error);
  if (reason?.reason.startsWith("sharing.")) {
    const key = `sharing.reason.${reason.reason.slice("sharing.".length)}`;
    if (hasMessage(key)) {
      const params = { ...reason.params };
      // Sizes arrive in bytes; people read megabytes.
      if (
        params.max !== undefined &&
        (reason.reason === "sharing.snapshot_too_large" ||
          reason.reason === "sharing.snapshot_storage_full")
      ) {
        params.max = bytesText(Number(params.max), language);
      }
      return t(key, params);
    }
  }
  if (isApiError(error, "rate_limited")) {
    return t("sharing.reason.rate_limited");
  }
  return errorMessage(t, error);
}
