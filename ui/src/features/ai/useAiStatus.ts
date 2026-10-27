import { useQuery } from "@tanstack/react-query";
import type { AiStatus } from "../../api/generated/shapes";
import { useCurrentOrg } from "../../org/useOrg";
import { aiStatusQuery } from "./api";

export interface AiAvailability {
  /**
   * True only when the server has AI turned on and a provider is in effect for the organization.
   * Everything AI in the UI (buttons, hints, menus) renders only then; while the status loads,
   * after an error and without an organization it is false, so nothing flashes.
   */
  usable: boolean;
  /** The server's answer, once it arrived. */
  status: AiStatus | undefined;
}

/** `useAiStatus` for a given organization; `undefined` asks nothing and is never usable. */
export function useAiStatusFor(orgId: string | undefined): AiAvailability {
  const query = useQuery({ ...aiStatusQuery(orgId ?? ""), enabled: orgId !== undefined });
  const status = orgId === undefined || query.isError ? undefined : query.data;
  return { usable: status?.enabled === true && status.usable, status };
}

/** Whether AI may be shown to the signed-in user in the organization they work in. */
export function useAiStatus(): AiAvailability {
  return useAiStatusFor(useCurrentOrg()?.id);
}
