import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { ErrorBody, QueryOutcome } from "../api/generated/shapes";
import { type LiveConnectionState, type LiveSpec, type LiveStatus, liveClient } from "./client";

/** What one live subscription shows: how its feed stays current, its last error and result time. */
export interface LiveView {
  /** Whether a subscription runs (a spec was given). */
  on: boolean;
  status?: LiveStatus | undefined;
  /** Why the subscription was refused or ended; it does not come back by itself. */
  error?: ErrorBody | undefined;
  /** When the queries of the last result ran (Unix ms). */
  at?: number | undefined;
  connection: LiveConnectionState;
}

/** The connection state of the organization's live client, for an indicator. */
export function useLiveConnection(orgId: string): LiveConnectionState {
  return useSyncExternalStore(
    (onChange) => liveClient(orgId).watch(onChange),
    () => liveClient(orgId).state,
  );
}

/**
 * Follows one live subscription while `spec` is set; `onResult` gets every result. A spec with
 * the same content keeps the subscription, so callers may build it on every render.
 */
export function useLiveSubscription(
  orgId: string,
  spec: LiveSpec | null,
  onResult: (results: Record<string, QueryOutcome>, at: number) => void,
): LiveView {
  const key = spec === null ? null : JSON.stringify(spec);
  const [state, setState] = useState<{
    key: string | null;
    status?: LiveStatus;
    error?: ErrorBody;
    at?: number;
  }>({ key: null });
  const deliver = useEffectEvent(onResult);
  const connection = useLiveConnection(orgId);

  useEffect(() => {
    if (key === null) {
      return;
    }
    // Updates of an earlier spec never land on this one.
    const update = (change: { status?: LiveStatus; error?: ErrorBody; at?: number }) =>
      setState((current) => (current.key === key ? { ...current, ...change } : { key, ...change }));
    return liveClient(orgId).subscribe(JSON.parse(key) as LiveSpec, {
      onResult: (results, at) => {
        deliver(results, at);
        update({ at });
      },
      onStatus: (status) => update({ status }),
      onError: (error) => update({ error }),
    });
  }, [orgId, key]);

  const own = state.key === key ? state : { key };
  return { on: key !== null, status: own.status, error: own.error, at: own.at, connection };
}
