import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
} from "react";
import { createPortal } from "react-dom";
import { useI18n } from "../../../i18n/i18n";
import { useEscapeLayer } from "../../../lib/layers";
import { showToast } from "../../../lib/toasts";
import { useBackGuard, useTypedInput } from "../../../lib/useBackGuard";
// Dialogs and the popover are used outside the administration too (stream areas).
import "../admin.css";

const FOCUSABLE =
  'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

function focusables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE));
}

export interface DialogProps {
  open: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  /** Buttons at the bottom; the dialog adds nothing on its own. */
  footer?: ReactNode;
  /** What receives focus on open; the first focusable element otherwise. */
  initialFocus?: RefObject<HTMLElement | null>;
  wide?: boolean;
  /** The id of the element that describes the dialog (read after the title); a confirmation's text. */
  describedBy?: string;
}

/**
 * A modal dialog: Tab stays inside, Escape closes it when it is the topmost layer, and focus
 * returns to where it was when the dialog opened.
 */
export function Dialog({
  open,
  title,
  onClose,
  children,
  footer,
  initialFocus,
  wide = false,
  describedBy,
}: DialogProps) {
  const { t } = useI18n();
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const typed = useTypedInput();
  const keep = () => showToast({ message: t("common.dialog.backKept") });
  useEscapeLayer(open, () => (typed.has() ? keep() : onClose()));
  // The Back button closes the dialog (or keeps typed input) rather than leaving the page.
  useBackGuard(open, { onClose, hasInput: typed.has, onKept: keep });

  const focusInitial = useEffectEvent(() => {
    const dialog = dialogRef.current;
    if (dialog === null) {
      return;
    }
    (initialFocus?.current ?? focusables(dialog)[0] ?? dialog).focus();
  });

  useEffect(() => {
    if (!open) {
      return;
    }
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    typed.reset();
    focusInitial();
    return () => {
      // Only if it still exists: the row that opened a delete dialog may be gone afterwards.
      if (opener?.isConnected === true) {
        opener.focus();
      }
    };
  }, [open, typed.reset]);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const dialog = dialogRef.current;
    if (event.key !== "Tab" || dialog === null) {
      return;
    }
    const items = focusables(dialog);
    const first = items[0];
    const last = items.at(-1);
    if (first === undefined || last === undefined) {
      event.preventDefault();
      return;
    }
    if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  if (!open) {
    return null;
  }
  return createPortal(
    <div className="admin-dialog__backdrop">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy}
        tabIndex={-1}
        className={wide ? "admin-dialog admin-dialog--wide" : "admin-dialog"}
        onKeyDown={onKeyDown}
        onInput={typed.onInput}
      >
        <h2 className="admin-dialog__title" id={titleId}>
          {title}
        </h2>
        <div className="admin-dialog__body">{children}</div>
        {footer === undefined ? null : <div className="admin-dialog__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  busy?: boolean;
  /** An error from the last attempt, shown above the buttons. */
  error?: ReactNode;
}

/**
 * Asks before something that cannot be undone. Focus starts on Cancel, so Enter does not delete.
 */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  busy = false,
  error,
}: ConfirmDialogProps) {
  const { t } = useI18n();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  return (
    <Dialog
      open={open}
      title={title}
      onClose={onClose}
      initialFocus={cancelRef}
      describedBy={textId}
      footer={
        <>
          <button
            ref={cancelRef}
            type="button"
            className="button button--secondary"
            onClick={onClose}
          >
            {t("admin.common.cancel")}
          </button>
          <button
            type="button"
            className="button button--danger"
            aria-disabled={busy}
            onClick={() => {
              if (!busy) {
                onConfirm();
              }
            }}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div id={textId} className="admin-dialog__text">
        {children}
      </div>
      {error === undefined || error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
