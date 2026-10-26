import { useEffect, useState } from "react";
import type { FieldDistribution } from "../api/generated/shapes";
import type { DistributionSource } from "../panels/types";
import type { PathStep } from "./paths";

/**
 * Field distributions counted in the database, kept per question: counting a whole result is
 * expensive, so a panel never asks again for a refresh of the same query (or a page loaded after
 * it) while its answer is younger than `DISTRIBUTION_FRESH_MS`, never asks twice at once, and asks
 * at once after an explicit refresh (`DistributionSource.manual`).
 */

/** How long an answer serves refreshes of the same question. */
export const DISTRIBUTION_FRESH_MS = 5 * 60_000;
/** Answers kept, the oldest dropped first. */
const MAX_KEPT = 100;

interface Kept {
  answer: FieldDistribution;
  /** When it was counted (ms). */
  at: number;
  /** The `manual` count it was asked with. */
  manual: number;
}

interface Asking {
  promise: Promise<FieldDistribution>;
  controller: AbortController;
  manual: number;
  /** Panels waiting for it; the request stops when the last one goes. */
  waiting: number;
}

const kept = new Map<string, Kept>();
const asking = new Map<string, Asking>();

function keep(key: string, entry: Kept) {
  kept.delete(key);
  kept.set(key, entry);
  while (kept.size > MAX_KEPT) {
    const oldest = kept.keys().next().value;
    if (oldest === undefined) {
      break;
    }
    kept.delete(oldest);
  }
}

/** Forgets every answer (tests). */
export function forgetDistributions(): void {
  kept.clear();
  for (const a of asking.values()) {
    a.controller.abort();
  }
  asking.clear();
}

export type Whole =
  | { status: "loading" }
  /** `refreshing`: a newer count is on its way while this one shows. */
  | { status: "done"; answer: FieldDistribution; at: number; refreshing: boolean }
  | { status: "failed"; error: unknown };

/**
 * The distribution of `steps` in document set `index` over the whole result, from the source.
 * A change of field, set or question cancels the request before (unless another panel still
 * waits for it); `null` when the server is not asked.
 */
export function useWholeDistribution(
  source: DistributionSource<number> | undefined,
  index: number,
  steps: PathStep[] | null,
  revision: string | number | undefined,
): { whole: Whole | null; retry: () => void } {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ key: string; whole: Whole } | null>(null);
  const key =
    source === undefined || steps === null ? null : JSON.stringify([source.identity, index, steps]);
  const manual = source?.manual ?? 0;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the key holds the question; a new result (`revision`), an explicit refresh (`manual`) or a retry are when to look again; the runner is a new function on every render
  useEffect(() => {
    if (key === null || source === undefined || steps === null) {
      return;
    }
    const now = Date.now();
    const old = kept.get(key);
    if (old !== undefined && old.manual === manual && now - old.at < DISTRIBUTION_FRESH_MS) {
      setState({ key, whole: { status: "done", ...old, refreshing: false } });
      return;
    }
    let request = asking.get(key);
    if (request === undefined || request.manual !== manual) {
      // An explicit refresh replaces a request still on its way for an older one.
      request?.controller.abort();
      const controller = new AbortController();
      const promise = source.run(index, { path: steps }, controller.signal);
      const made: Asking = { promise, controller, manual, waiting: 0 };
      request = made;
      asking.set(key, made);
      promise.then(
        (answer) => {
          if (asking.get(key) === made) {
            asking.delete(key);
            keep(key, { answer, at: Date.now(), manual });
          }
        },
        () => {
          if (asking.get(key) === made) {
            asking.delete(key);
          }
        },
      );
    }
    const mine = request;
    mine.waiting++;
    setState({
      key,
      whole:
        old === undefined ? { status: "loading" } : { status: "done", ...old, refreshing: true },
    });
    let live = true;
    mine.promise.then(
      (answer) => {
        if (live) {
          setState({ key, whole: { status: "done", answer, at: Date.now(), refreshing: false } });
        }
      },
      (error: unknown) => {
        if (live && !mine.controller.signal.aborted) {
          setState({ key, whole: { status: "failed", error } });
        }
      },
    );
    return () => {
      live = false;
      mine.waiting--;
      // Another effect may take it up in the same commit (a re-render); stop it only when none did.
      queueMicrotask(() => {
        if (mine.waiting === 0 && asking.get(key) === mine) {
          mine.controller.abort();
          asking.delete(key);
        }
      });
    };
  }, [key, manual, revision, attempt]);
  const whole: Whole | null =
    key === null ? null : state?.key === key ? state.whole : { status: "loading" };
  return { whole, retry: () => setAttempt((n) => n + 1) };
}
