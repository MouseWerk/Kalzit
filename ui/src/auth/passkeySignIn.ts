/**
 * Signing in with a passkey alone (board Auth.dc.html, frame 5; docs/api/access.md, "Passkey
 * sign-in"): the button "Mit Passkey anmelden", which opens the browser's dialog, and the
 * passkeys the browser suggests in the address field (conditional mediation). Both ask the server
 * for a dialog without an account and send the answer back; a passkey that verified the person
 * is both factors, so the answer is the session.
 *
 * The suggestion waits while the person types. It is renewed before the server's dialog ends
 * (five minutes), set aside while the button's dialog is open (a browser runs one passkey request
 * at a time), and started again after it.
 */
import { useEffect, useRef, useState } from "react";
import { type Me, passkeySignIn, passkeySignInOptions } from "../api/auth";
import { isApiError } from "../api/client";
import { errorReason } from "../features/datasources/reasons";
import {
  getPasskey,
  isPasskeyCancelled,
  passkeySuggestionsAvailable,
  passkeysAvailable,
} from "../features/security/webauthn";

/** The server keeps a dialog five minutes; the suggestion starts anew a little before. */
export const SUGGESTION_RENEW_MS = 4.5 * 60_000;

/** Why the last attempt did not sign in. */
export type PasskeyFailure =
  /** Cancelled, timed out, no passkey on the device, or the dialog ended: nothing is broken. */
  | "cancelled"
  /** The passkey held for no account that may sign in with it (one answer for every reason). */
  | "refused"
  /** Too many passkey dialogs from this address (a shared office line): the password goes on. */
  | "busy"
  /** Anything else (the server did not answer, rate limits, errors); the page shows it. */
  | { error: unknown };

/** What the page shows: nothing, the button's dialog open, or an answer being checked. */
export type PasskeyPhase = "idle" | "waiting" | "checking";

const REFUSED = "passkey_sign_in.refused";

/** How long the suggestion waits before it starts again after a failure it did not show. */
const SUGGESTION_RETRY_MS = 30_000;

function failureOf(error: unknown): PasskeyFailure {
  if (isPasskeyCancelled(error)) {
    return "cancelled";
  }
  if (isApiError(error, "rate_limited")) {
    return "busy";
  }
  if (isApiError(error, "invalid_credentials")) {
    // Refused, or the dialog had ended (`passkey_sign_in.expired`): then it only needs a retry.
    return errorReason(error)?.reason === REFUSED ? "refused" : "cancelled";
  }
  return { error };
}

export interface PasskeySignIn {
  /** The button can be offered: the server allows it and the browser has passkeys. */
  offered: boolean;
  /** The browser suggests passkeys in the address field. */
  suggests: boolean;
  phase: PasskeyPhase;
  failure: PasskeyFailure | null;
  /** Opens the browser's dialog ("Mit Passkey anmelden"). */
  start: () => void;
  /** Closes the dialog the button opened. */
  cancel: () => void;
  /** Forgets the last failure (another attempt with the password began). */
  clear: () => void;
}

/**
 * `allowed`: the server's answer (`passkeySignIn` of the providers) and the page's own conditions.
 * `shared` is read when the answer is sent, so a box ticked meanwhile counts. `onSignedIn` gets
 * the session's user.
 */
export function usePasskeySignIn({
  allowed,
  shared,
  onSignedIn,
}: {
  allowed: boolean;
  shared: boolean;
  onSignedIn: (me: Me) => Promise<void>;
}): PasskeySignIn {
  const offered = allowed && passkeysAvailable();
  const [suggestable, setSuggestable] = useState(false);
  /** Whose request is under way: the button's dialog, or a passkey picked from the suggestion. */
  const [busy, setBusy] = useState<"button" | "suggestion" | null>(null);
  /** The server checks an answer. */
  const [checking, setChecking] = useState(false);
  const [failure, setFailure] = useState<PasskeyFailure | null>(null);
  /** Counts the suggestion's starts; a new value starts a new one. */
  const [round, setRound] = useState(0);
  const sharedRef = useRef(shared);
  const signedInRef = useRef(onSignedIn);
  const suggestion = useRef<AbortController | null>(null);
  const dialog = useRef<AbortController | null>(null);

  useEffect(() => {
    sharedRef.current = shared;
    signedInRef.current = onSignedIn;
  });

  useEffect(() => {
    if (!offered) {
      return;
    }
    let current = true;
    void passkeySuggestionsAvailable().then((available) => {
      if (current) {
        setSuggestable(available);
      }
    });
    return () => {
      current = false;
    };
  }, [offered]);

  const suggests = offered && suggestable;
  const buttonOpen = busy === "button";
  const phase: PasskeyPhase = checking ? "checking" : buttonOpen ? "waiting" : "idle";

  // The suggestion in the address field, while no dialog of the button is open. Checking a
  // passkey picked from it changes none of these, so its answer is never cut off.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `round` starts a new suggestion.
  useEffect(() => {
    if (!suggests || buttonOpen) {
      return;
    }
    const controller = new AbortController();
    suggestion.current = controller;
    const renew = window.setTimeout(() => {
      controller.abort();
      setRound((value) => value + 1);
    }, SUGGESTION_RENEW_MS);
    void (async () => {
      let picked = false;
      try {
        const options = await passkeySignInOptions(controller.signal);
        const credential = await getPasskey(options, {
          mediation: "conditional",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          return;
        }
        picked = true;
        window.clearTimeout(renew);
        setBusy("suggestion");
        setChecking(true);
        setFailure(null);
        const me = await passkeySignIn({
          credential,
          ...(sharedRef.current ? { forgetBrowser: true } : {}),
        });
        await signedInRef.current(me);
      } catch (error) {
        if (picked) {
          setChecking(false);
          setBusy(null);
        } else if (controller.signal.aborted) {
          return;
        }
        window.clearTimeout(renew);
        // The suggestion ending on its own says nothing to the person; an answer that failed does.
        // A suggestion the server did not start (its budget for this address, an error) waits
        // before it asks again, so a busy address is not asked over and over; the form and the
        // password go on meanwhile.
        const cancelled = isPasskeyCancelled(error);
        const limited = isApiError(error, "rate_limited");
        if (picked || (!cancelled && !limited)) {
          setFailure(failureOf(error));
        }
        if (picked || cancelled) {
          setRound((value) => value + 1);
          return;
        }
        const wait = limited ? (error.retryAfterMs ?? SUGGESTION_RETRY_MS) : SUGGESTION_RETRY_MS;
        const retry = window.setTimeout(() => setRound((value) => value + 1), wait);
        controller.signal.addEventListener("abort", () => window.clearTimeout(retry));
      }
    })();
    return () => {
      window.clearTimeout(renew);
      controller.abort();
      if (suggestion.current === controller) {
        suggestion.current = null;
      }
    };
  }, [suggests, buttonOpen, round]);

  function start() {
    if (!offered || busy !== null) {
      return;
    }
    // A browser runs one passkey request at a time: the suggestion steps aside first.
    suggestion.current?.abort();
    const controller = new AbortController();
    dialog.current = controller;
    setFailure(null);
    setBusy("button");
    void (async () => {
      try {
        const options = await passkeySignInOptions(controller.signal);
        const credential = await getPasskey(options, { signal: controller.signal });
        setChecking(true);
        const me = await passkeySignIn({
          credential,
          ...(sharedRef.current ? { forgetBrowser: true } : {}),
        });
        await signedInRef.current(me);
      } catch (error) {
        setFailure(failureOf(error));
        setChecking(false);
        setBusy(null);
      } finally {
        if (dialog.current === controller) {
          dialog.current = null;
        }
      }
    })();
  }

  function cancel() {
    dialog.current?.abort();
  }

  function clear() {
    setFailure(null);
  }

  return { offered, suggests, phase, failure, start, cancel, clear };
}
