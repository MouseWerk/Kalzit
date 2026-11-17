import { useQuery } from "@tanstack/react-query";
import { isApiError } from "../../api/client";
import { hasMessage, type Translate } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import { listOrgSettings, listServerSettings, type Setting } from "../admin/api";
import { errorMessage } from "../dashboards/ui/errors";
import { errorReason } from "../datasources/reasons";
import { SHARING_KEY } from "./api";
import { bytesText, DEFAULT_MAX_EXPIRY_DAYS, DEFAULT_SNAPSHOT_MAX_BYTES } from "./model";

/**
 * Why nothing public can be made here, in the order people can act on it: the server's switch,
 * the organization's, a switch somewhere (the server refused, and the caller may not read the
 * settings), or the missing permission.
 */
export type PublicBlock = "server" | "org" | "off" | "permission";

export interface SharingLimits {
  /** Undefined when public sharing is open to the caller, as far as the UI can tell. */
  block: PublicBlock | undefined;
  maxExpiryDays: number;
  snapshotMaxBytes: number;
}

function settingValue(settings: readonly Setting[] | undefined, key: string): unknown {
  return settings?.find((setting) => setting.key === key)?.value;
}

/**
 * The sharing switches and limits as far as the caller may read them: server administrators the
 * server's, people with `settings:read` the organization's. Everyone else learns of a switch
 * that is off from the server's refusal (`refused`, set by the dialog). Only for showing why
 * something is unavailable: the server checks every request.
 */
export function useSharingLimits(orgId: string, refused = false): SharingLimits {
  const permissions = useOrgPermissions();
  const server = useQuery({
    queryKey: [SHARING_KEY, "settings", "server"],
    queryFn: listServerSettings,
    enabled: permissions.isServerAdmin,
    staleTime: 30_000,
  });
  const org = useQuery({
    queryKey: [SHARING_KEY, "settings", orgId],
    queryFn: () => listOrgSettings(orgId),
    enabled: orgId !== "" && permissions.has("settings:read"),
    staleTime: 30_000,
  });
  const maxDays = settingValue(server.data, "sharing.max_expiry_days");
  const maxBytes = settingValue(server.data, "sharing.snapshot_max_bytes");
  let block: PublicBlock | undefined;
  if (settingValue(server.data, "sharing.public_enabled") === false) {
    block = "server";
  } else if (settingValue(org.data, "sharing.org_public_enabled") === false) {
    block = "org";
  } else if (refused) {
    block = "off";
  } else if (permissions.loaded && !permissions.has("dashboards:public")) {
    block = "permission";
  }
  return {
    block,
    maxExpiryDays: typeof maxDays === "number" && maxDays > 0 ? maxDays : DEFAULT_MAX_EXPIRY_DAYS,
    snapshotMaxBytes:
      typeof maxBytes === "number" && maxBytes > 0 ? maxBytes : DEFAULT_SNAPSHOT_MAX_BYTES,
  };
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
      if (params.max !== undefined && reason.reason === "sharing.snapshot_too_large") {
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
