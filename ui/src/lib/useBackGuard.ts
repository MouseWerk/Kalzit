import { useRouter } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

/** The open guards, in the order they opened; only the topmost one answers the Back button. */
const guards: object[] = [];

/** Whether a dialog or overlay holds the Back button (a page's own leave guard stands back). */
export function hasBackGuard(): boolean {
  return guards.length > 0;
}

interface BackGuardOptions {
  /** Closes the layer (Back with nothing typed into it). */
  onClose: () => void;
  /** Whether there is typed input that closing would lose. */
  hasInput: () => boolean;
  /** Called when Back was held because of typed input. */
  onKept: () => void;
}

/**
 * Makes the browser's or mouse's Back (and Forward) button act on a modal dialog or overlay
 * instead of leaving the page behind it: while `active`, the navigation is held. With nothing
 * typed into it the layer closes, as Escape does, and the page stays; with input in it, the layer
 * stays open and `onKept` tells the person that the input is still there. Without a router (a
 * dialog in a test or an isolated surface) a popstate closes the layer. Leaving the page with
 * the tab (reload, close) asks only while there is typed input.
 */
export function useBackGuard(active: boolean, options: BackGuardOptions): void {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });
  useEffect(() => {
    if (!active) {
      return;
    }
    const me = {};
    guards.push(me);
    const forget = () => {
      const index = guards.lastIndexOf(me);
      if (index !== -1) {
        guards.splice(index, 1);
      }
    };
    const answer = () => {
      if (latest.current.hasInput()) {
        latest.current.onKept();
      } else {
        latest.current.onClose();
      }
    };
    const history = router?.history;
    if (history === undefined) {
      const onPop = () => {
        if (guards.at(-1) === me) {
          answer();
        }
      };
      window.addEventListener("popstate", onPop);
      return () => {
        window.removeEventListener("popstate", onPop);
        forget();
      };
    }
    const unblock = history.block({
      blockerFn: ({ action }: { action: string }) => {
        // A truthy answer holds the navigation. Links and redirects (push, replace) pass.
        if (action === "PUSH" || action === "REPLACE") {
          return false;
        }
        // Under another guard this one stands back (the topmost holds the navigation and acts).
        if (guards.at(-1) !== me) {
          return false;
        }
        answer();
        return true;
      },
      enableBeforeUnload: () => latest.current.hasInput(),
    });
    return () => {
      unblock();
      forget();
    };
  }, [active, router]);
}

/**
 * Tracks whether something was typed into a dialog's fields, for the guards above and Escape. An
 * `onInput` on the dialog element collects the fields touched; a field that was emptied again
 * no longer counts.
 */
export function useTypedInput(): {
  onInput: (event: { target: EventTarget }) => void;
  has: () => boolean;
  reset: () => void;
} {
  const touched = useRef(new Set<EventTarget>());
  // One object for the life of the dialog, so it is safe in effect dependencies.
  const [tracker] = useState(() => ({
    onInput: (event: { target: EventTarget }) => {
      const field = event.target as { value?: unknown };
      if (field.value === "") {
        touched.current.delete(event.target);
      } else {
        touched.current.add(event.target);
      }
    },
    has: () => touched.current.size > 0,
    reset: () => touched.current.clear(),
  }));
  return tracker;
}
