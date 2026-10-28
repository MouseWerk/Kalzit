import type { QueryClient } from "@tanstack/react-query";
import { createRoute, lazyRouteComponent, notFound } from "@tanstack/react-router";
import type { Me } from "../../../api/auth";
import { appRoute } from "../../../app/baseRoutes";
import { currentOrgOf } from "../../../org/useOrg";
import { aiStatusQuery } from "../api";

export interface AskSearch {
  /** The chat shown; absent for a new one. */
  chat?: string | undefined;
}

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
  if (status?.enabled !== true || !status.usable) {
    throw notFound();
  }
}

const askRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/ask",
  validateSearch: (search: Record<string, unknown>): AskSearch => ({
    chat: typeof search.chat === "string" && search.chat !== "" ? search.chat : undefined,
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
