import { useQuery } from "@tanstack/react-query";
import { useCurrentOrg } from "../../../org/useOrg";
import type { NavItem } from "../../../shell/navItem";
import { aiStatusQuery } from "../api";
import { featureUsable } from "../useAiStatus";

/**
 * Shown only while AI is usable for the person; otherwise there is no entry, not even greyed.
 * Undefined while the AI status is on its way.
 */
function useAiUsable(): boolean | undefined {
  const org = useCurrentOrg();
  const query = useQuery({ ...aiStatusQuery(org?.id ?? ""), enabled: org !== undefined });
  if (org === undefined || query.isError) {
    return false;
  }
  return query.data === undefined ? undefined : featureUsable(query.data, "chat");
}

/**
 * "Fragen", the agent chat (board DataChat.dc.html), between Explore and the data sources. No
 * permission shows it: whether AI is usable decides, from the AI status the shell asks anyway.
 * Viewers see it too; they ask about the panels of the dashboards they may read.
 */
export const askNav: NavItem = {
  to: "/ask",
  label: "ai.chat.nav",
  icon: "ask",
  badge: "ai.chat.beta",
  visible: () => false,
  useGranted: useAiUsable,
  prime: (ensure, orgId) => ensure(aiStatusQuery(orgId)),
};
