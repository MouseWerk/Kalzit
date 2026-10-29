import type { QueryClient } from "@tanstack/react-query";
import { createRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";
import type { Me } from "../../../api/auth";
import { appRoute } from "../../../app/baseRoutes";
import { currentOrgOf } from "../../../org/useOrg";
import { aiStatusQuery } from "../api";
import { featureUsable } from "../useAiStatus";

export interface AskSearch {
  /** The chat shown; absent for a new one. */
  chat?: string | undefined;
  /** A new chat about this dashboard ("In Fragen öffnen" from a panel). */
  dashboard?: string | undefined;
  /** A new chat on this source (after a summary in Explore). */
  source?: string | undefined;
  /** The question to start with, in the composer, not sent. */
  q?: string | undefined;
}

/** The longest question a link may start a chat with. */
const MAX_LINKED_QUESTION = 500;

const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : undefined);

/**
 * "Fragen" exists only while AI is usable for the person (on, with a provider in effect): else
 * its pages are not found, as if there were none, and the navigation has no entry for them.
 */
async function requireUsableAi(queryClient: QueryClient, me: Me): Promise<void> {
  const org = currentOrgOf(me);
  if (org === undefined) {
    throw notFound();
  }
  const status = await queryClient.ensureQueryData(aiStatusQuery(org.id)).catch(() => undefined);
  if (!featureUsable(status, "chat")) {
    throw notFound();
  }
}

const askRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ask",
  validateSearch: (search: Record<string, unknown>): AskSearch => ({
    chat: text(search.chat),
    dashboard: text(search.dashboard),
    source: text(search.source),
    q: text(search.q)?.slice(0, MAX_LINKED_QUESTION),
  }),
  beforeLoad: ({ context }) => requireUsableAi(context.queryClient, context.me),
  component: lazyRouteComponent(() => import("./AskPage"), "AskPage"),
});

const historyRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ask/history",
  beforeLoad: ({ context }) => requireUsableAi(context.queryClient, context.me),
  component: lazyRouteComponent(() => import("./ChatHistoryPage"), "ChatHistoryPage"),
});

export const askRoutes = [askRoute, historyRoute] as const;
