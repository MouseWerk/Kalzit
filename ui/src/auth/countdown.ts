import { useEffect, useState } from "react";
import { isApiError } from "../api/client";

/** Used when a rate-limited answer names no wait: the shortest window the server counts in. */
const FALLBACK_WAIT_MS = 60_000;

/** The moment a rate-limited attempt may be made again, from the server's `Retry-After`. */
export function waitUntil(error: unknown, now = Date.now()): number | null {
  if (!isApiError(error, "rate_limited")) {
    return null;
  }
  return now + (error.retryAfterMs ?? FALLBACK_WAIT_MS);
}

/**
 * The whole seconds left until `until`, ticking once a second; 0 once it has passed or when
 * there is nothing to wait for. The timer stops when the wait is over.
 */
export function useCountdown(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null) {
      return;
    }
    setNow(Date.now());
    const timer = window.setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= until) {
        window.clearInterval(timer);
      }
    }, 1000);
    return () => window.clearInterval(timer);
  }, [until]);
  return until === null ? 0 : Math.max(0, Math.ceil((until - now) / 1000));
}

/** "3:58": minutes and seconds, as the button shows the time left. */
export function formatWait(seconds: number): string {
  const whole = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}
