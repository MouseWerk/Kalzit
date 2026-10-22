import { useEffect, useState } from "react";
import { useI18n } from "../i18n/i18n";
import { dismissToast, TOAST_MS, type Toast, UNDO_TOAST_MS, useToast } from "../lib/toasts";
import { Icon } from "./Icon";
import "../shell/shellUx.css";

/**
 * The one notification region of the app, at the bottom of the window. Both live regions stay
 * mounted, because screen readers only announce changes inside a region that already existed:
 * confirmations go to the polite one, errors to the assertive one. A confirmation leaves on its
 * own after a while, but never while the pointer or keyboard focus is on it; an error stays until
 * it is dismissed.
 */
export function Toaster() {
  const toast = useToast();
  const body = toast === null ? null : <ToastBody key={toast.id} toast={toast} />;
  return (
    <div className="toaster">
      <div role="status" aria-atomic="true" className="toaster__region">
        {toast?.error === true ? null : body}
      </div>
      <div role="alert" aria-atomic="true" className="toaster__region">
        {toast?.error === true ? body : null}
      </div>
    </div>
  );
}

function ToastBody({ toast }: { toast: Toast }) {
  const { t } = useI18n();
  const [held, setHeld] = useState(false);

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

  return (
    // Pointer and focus only hold the toast while someone reads or reaches it; its buttons act.
    // biome-ignore lint/a11y/noStaticElementInteractions: holding the timer is not an interaction.
    <div
      className={toast.error === true ? "toast notice notice--danger" : "toast notice"}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
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
      <div className="toast__actions">
        {toast.undo === undefined ? null : (
          <button
            type="button"
            className="toast__button"
            onClick={() => {
              const undo = toast.undo;
              dismissToast(toast.id);
              undo?.();
            }}
          >
            {t("shell.toast.undo")}
          </button>
        )}
        <button type="button" className="toast__button" onClick={() => dismissToast(toast.id)}>
          {t("shell.toast.dismiss")}
        </button>
      </div>
    </div>
  );
}
