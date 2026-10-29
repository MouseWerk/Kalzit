import type { NavItem } from "../../../shell/navItem";
import { useAiFeature } from "../useAiStatus";

/** Shown only while AI is usable for the person; otherwise there is no entry, not even greyed. */
function useAiUsable(): boolean {
  return useAiFeature("chat");
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
};
