import type { ReactNode } from "react";
import { useAiStatus, useAiStatusFor } from "./useAiStatus";

/**
 * Renders its children only when AI is usable for the signed-in user (on, with a provider in
 * effect). Every AI button, menu entry or hint goes inside one, so with AI off or not set up the
 * UI shows nothing of it: no placeholder, no disabled button, no hint.
 */
export function AiGate({ children }: { children: ReactNode }) {
  const { usable } = useAiStatus();
  return usable ? children : null;
}

/** `AiGate` for a given organization, for places outside the app's routes and for tests. */
export function AiGateFor({ orgId, children }: { orgId: string | undefined; children: ReactNode }) {
  const { usable } = useAiStatusFor(orgId);
  return usable ? children : null;
}
