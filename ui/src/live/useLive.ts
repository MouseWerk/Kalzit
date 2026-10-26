import { useEffect, useEffectEvent, useState, useSyncExternalStore } from "react";
import type { ErrorBody, QueryOutcome } from "../api/generated/shapes";
import { type LiveConnectionState, type LiveSpec, type LiveStatus, liveClient } from "./client";

/** What one live subscription shows: how its feed stays current, its last error and result time. */
export interface LiveView {
  /** Whether a subscription runs (a spec was given). */
  on: boolean;
  status?: LiveStatus | undefined;
  /** Why the subscription was refused or ended; a later status or result clears it. */
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

interface Followed {
  /** The subscription the state belongs to; every start of one makes a new token. */
  token: object | null;
  status?: LiveStatus | undefined;
  error?: ErrorBody | undefined;
  at?: number | undefined;
}

/**
 * Follows one live subscription while `spec` is set; `onResult` gets every result together with
 * the `target` the subscription was started for (a cache key), never a later render's. A spec
 * and target with the same content keep the subscription, so callers may build them on every
 * render; another target starts a new subscription.
 */
export function useLiveSubscription<T>(
  orgId: string,
  spec: LiveSpec | null,
  target: T,
  onResult: (results: Record<string, QueryOutcome>, at: number, target: T) => void,
): LiveView {
  const key = spec === null ? null : JSON.stringify([spec, target]);
  const [state, setState] = useState<Followed>({ token: null });
  const deliver = useEffectEvent(onResult);
  const connection = useLiveConnection(orgId);

  useEffect(() => {
    if (key === null) {
      return;
    }
    const [liveSpec, captured] = JSON.parse(key) as [LiveSpec, T];
    // A new start forgets what an earlier one (also with the same spec) said.
    const token = {};
    setState({ token });
    const update = (change: Omit<Followed, "token">) =>
      setState((current) => (current.token === token ? { ...current, ...change } : current));
    const end = liveClient(orgId).subscribe(liveSpec, {
      onResult: (results, at) => {
        deliver(results, at, captured);
        update({ at, error: undefined });
      },
      onStatus: (status) => update({ status, error: undefined }),
      onError: (error) => update({ error }),
    });
    return () => {
      end();
      setState({ token: null });
    };
  }, [orgId, key]);

  const own: Followed = key === null ? { token: null } : state;
  return { on: key !== null, status: own.status, error: own.error, at: own.at, connection };
}
