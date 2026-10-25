import { useRouter } from "@tanstack/react-router";
import { useEffect, useEffectEvent } from "react";

/** The open guards, in the order they opened; only the topmost one answers the Back button. */
const guards: object[] = [];

/**
 * Makes the browser's or mouse's Back (and Forward) button act on a modal dialog instead of
 * leaving the page behind it: while `active`, the navigation is held. With nothing typed into
 * the dialog it closes, as Escape does, and the page stays; with input in it, the dialog stays
 * open and `onKept` tells the person that the input is still there. Without a router (a dialog
 * in a test or an isolated surface) a popstate closes the dialog.
 */
export function useBackGuard(
  active: boolean,
  {
    onClose,
    hasInput,
    onKept,
  }: { onClose: () => void; hasInput: () => boolean; onKept: () => void },
): void {
  const router = useRouter({ warn: false }) as ReturnType<typeof useRouter> | undefined;
  const close = useEffectEvent(onClose);
  const dirty = useEffectEvent(hasInput);
  const kept = useEffectEvent(onKept);
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
      if (guards.at(-1) !== me) {
        return;
      }
      if (dirty()) {
        kept();
      } else {
        close();
      }
    };
    const history = router?.history;
    if (history === undefined) {
      const onPop = () => answer();
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
        answer();
        return true;
      },
    });
    return () => {
      unblock();
      forget();
    };
  }, [active, router]);
}
