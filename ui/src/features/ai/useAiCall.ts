import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { errorFromResponse } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { AI_STATUS_QUERY_KEY } from "./api";
import { type AiCallDone, type AiCallMeta, type AiCallRequest, streamAiCall } from "./calls";

/**
 * Where a call is: `waiting` until the first text arrives, `streaming` while it is written,
 * `done` when the answer is whole, `error` when it was refused or failed, `stopped` when the
 * person stopped it (what arrived stays).
 */
export type AiCallPhase = "idle" | "waiting" | "streaming" | "done" | "error" | "stopped";

export interface AiCallState {
  phase: AiCallPhase;
  /** The answer so far. */
  text: string;
  meta: AiCallMeta | undefined;
  done: AiCallDone | undefined;
  /** An ApiError, from a refusal before the start or an error event. */
  error: unknown;
  /** When the call started, for "takes longer" and the duration. */
  startedAt: number;
  /** When it ended, for the duration. */
  endedAt: number | undefined;
  /** The request, so "Try again" repeats it. */
  request: AiCallRequest | undefined;
}

const IDLE: AiCallState = {
  phase: "idle",
  text: "",
  meta: undefined,
  done: undefined,
  error: undefined,
  startedAt: 0,
  endedAt: undefined,
  request: undefined,
};

export interface AiCall {
  state: AiCallState;
  start: (request: AiCallRequest) => void;
  /** Stops a running call: the request is closed, the server cancels and counts it. */
  stop: () => void;
  reset: () => void;
}

/**
 * One AI call at a time for a place in the UI: start, stop, and its state as the events arrive.
 * A new start stops the one before; leaving the page stops it too. After every call the status
 * is asked again, so the usage and the limits the buttons follow are current.
 */
export function useAiCall(orgId: string): AiCall {
  const { language } = useI18n();
  const queryClient = useQueryClient();
  const [state, setState] = useState<AiCallState>(IDLE);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => () => abort.current?.abort(), []);

  function start(request: AiCallRequest) {
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const startedAt = Date.now();
    setState({ ...IDLE, phase: "waiting", startedAt, request });
    const mine = () => abort.current === controller;
    const update = (change: (current: AiCallState) => AiCallState) => {
      if (mine()) {
        setState(change);
      }
    };
    void streamAiCall(
      orgId,
      request,
      language,
      {
        onMeta: (meta) => update((s) => ({ ...s, meta })),
        onText: (text) => update((s) => ({ ...s, phase: "streaming", text: s.text + text })),
        onDone: (done) => update((s) => ({ ...s, phase: "done", done, endedAt: Date.now() })),
        onError: (body) =>
          update((s) => ({
            ...s,
            phase: "error",
            error: errorFromResponse(502, body),
            endedAt: Date.now(),
          })),
      },
      controller.signal,
    )
      .then(() =>
        // A stream that ended without `done` or `error` broke off on the way.
        update((s) =>
          s.phase === "waiting" || s.phase === "streaming"
            ? {
                ...s,
                phase: "error",
                error: errorFromResponse(502, undefined),
                endedAt: Date.now(),
              }
            : s,
        ),
      )
      .catch((error: unknown) => {
        if (controller.signal.aborted) {
          return;
        }
        update((s) => ({ ...s, phase: "error", error, endedAt: Date.now() }));
      })
      .finally(() => {
        void queryClient.invalidateQueries({ queryKey: [AI_STATUS_QUERY_KEY, orgId] });
      });
  }

  function stop() {
    const running = abort.current;
    if (running === null) {
      return;
    }
    running.abort();
    abort.current = null;
    setState((s) =>
      s.phase === "waiting" || s.phase === "streaming"
        ? { ...s, phase: "stopped", endedAt: Date.now() }
        : s,
    );
  }

  function reset() {
    abort.current?.abort();
    abort.current = null;
    setState(IDLE);
  }

  return { state, start, stop, reset };
}
