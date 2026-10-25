import { useEffect, useRef, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { dismissToast, TOAST_MS, type Toast, UNDO_TOAST_MS, useToasts } from "../lib/toasts";
import { Icon } from "./Icon";
import "../shell/shellUx.css";

/**
 * The one notification region of the app, at the bottom of the window. Both live regions stay
 * mounted, because screen readers only announce changes inside a region that already existed:
 * confirmations go to the polite one ("Notifications"), errors to the assertive one ("Errors").
 * A confirmation leaves on its own after a while, but never while the pointer or keyboard focus
 * is on it; an error stays until it is dismissed, and a later confirmation does not replace it.
 * A toast with Undo sits in its own slot, so a plain confirmation never takes it away, and F6
 * reaches it from the keyboard (the live region says so).
 */
export function Toaster() {
  const { t } = useI18n();
  const { confirmation, undo, error } = useToasts();
  return (
    <div className="toaster">
      <div
        role="alert"
        aria-atomic="true"
        aria-label={t("shell.toast.errors")}
        className="toaster__region"
      >
        {error === null ? null : <ToastBody key={error.id} toast={error} />}
      </div>
      <div
        role="status"
        aria-atomic="true"
        aria-label={t("shell.toast.region")}
        className="toaster__region"
      >
        {undo === null ? null : <ToastBody key={undo.id} toast={undo} />}
        {confirmation === null ? null : <ToastBody key={confirmation.id} toast={confirmation} />}
      </div>
    </div>
  );
}

function ToastBody({ toast }: { toast: Toast }) {
  const { t } = useI18n();
  const [held, setHeld] = useState(false);
  // Where focus was before it came into the toast, to go back there when the toast closes.
  const returnTo = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (toast.error === true || held) {
      return;
    }
    const timer = window.setTimeout(
      () => dismissToast(toast.id),
      toast.undo === undefined ? TOAST_MS : UNDO_TOAST_MS,
    );
    return () => window.clearTimeout(timer);
  }, [toast, held]);

  /** Closes the toast; focus that was in it returns to where it came from, or to the content. */
  function close(then?: () => void) {
    const hadFocus =
      document.activeElement instanceof Node && ref.current?.contains(document.activeElement);
    const back = returnTo.current;
    dismissToast(toast.id);
    then?.();
    if (hadFocus === true) {
      const target =
        back?.isConnected === true ? back : document.querySelector<HTMLElement>("main#main");
      target?.focus();
    }
  }

  const ref = useRef<HTMLDivElement>(null);
  return (
    // Pointer and focus only hold the toast while someone reads or reaches it; its buttons act.
    // biome-ignore lint/a11y/noStaticElementInteractions: holding the timer is not an interaction.
    <div
      ref={ref}
      className={toast.error === true ? "toast notice notice--danger" : "toast notice"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={(event) => {
        setHeld(true);
        if (
          event.relatedTarget instanceof HTMLElement &&
          !event.currentTarget.contains(event.relatedTarget)
        ) {
          returnTo.current = event.relatedTarget;
        }
      }}
      onBlur={(event) => {
        if (
          !(
            event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)
          )
        ) {
          setHeld(false);
        }
      }}
    >
      <Icon name={toast.error === true ? "alert" : "check"} />
      <div className="toast__text">{toast.message}</div>
      {toast.undo === undefined ? null : (
        <span className="visually-hidden">{t("shell.toast.undoHint")}</span>
      )}
      <div className="toast__actions">
        {toast.undo === undefined ? null : (
          <button type="button" className="toast__button" onClick={() => close(toast.undo)}>
            {t("common.undo")}
          </button>
        )}
        <button type="button" className="toast__button" onClick={() => close()}>
          {t("common.dismiss")}
        </button>
      </div>
    </div>
  );
}
