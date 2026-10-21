import { type KeyboardEvent, type ReactNode, useId, useLayoutEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import "../dashboards.css";

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

interface DialogProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons at the bottom; the first element with `data-autofocus` receives focus on open. */
  actions?: ReactNode;
  size?: "small" | "large";
}

/**
 * A modal dialog: Escape closes it (only when it is the topmost layer), Tab stays inside, and
 * focus returns to where it was when the dialog closes.
 */
export function Dialog({ title, onClose, children, actions, size = "small" }: DialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);

  useEscapeLayer(true, onClose);

  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dialog = ref.current;
    if (dialog !== null) {
      const target =
        dialog.querySelector<HTMLElement>("[data-autofocus]") ?? focusables(dialog)[0] ?? dialog;
      target.focus();
    }
    return () => opener?.focus();
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Tab" || ref.current === null) {
      return;
    }
    const items = focusables(ref.current);
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  return createPortal(
    <div className="dialog-backdrop">
      <div
        ref={ref}
        className={`dialog dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        <div className="dialog__header">
          <h2 className="dialog__title" id={titleId}>
            {title}
          </h2>
          <button
            type="button"
            className="button button--ghost dialog__close"
            onClick={onClose}
            aria-label={t("dashboards.dialog.close")}
            title={t("dashboards.dialog.close")}
          >
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <div className="dialog__body">{children}</div>
        {actions === undefined ? null : <div className="dialog__actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  /** Error text from a failed attempt, shown inside the dialog. */
  error?: string | undefined;
}

/** Confirmation for a destructive action. Focus starts on Cancel, so Enter does not confirm. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  busy = false,
  error,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      actions={
        <>
          <button
            type="button"
            className="button button--secondary"
            onClick={onCancel}
            data-autofocus
          >
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            onClick={onConfirm}
            aria-disabled={busy}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{children}</p>
      {error === undefined ? null : (
        <p className="notice notice--danger" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
