import { useRef, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";
import { dismissToast, showToast } from "../../../lib/toasts";
import "../admin.css";

export interface NoticeContent {
  message: string;
  /** Offered as "Undo" next to the message; the change it reverts is already saved. */
  undo?: (() => void) | undefined;
  /** An error is announced assertively and drawn with the danger tint. */
  error?: boolean;
}

/**
 * Shows `content` after a change that ends with a navigation (a created role opens). Pages show
 * their notices in the app's notification region (`Toaster`), which outlives the page.
 */
export function setFlash(content: NoticeContent): void {
  showToast(content);
}

/**
 * Changes apply at once; each confirms itself with a notice that offers to undo it, and a failed
 * change is reported the same way. The next change replaces the notice.
 *
 * Pages use the app's notification region. A dialog passes `inline`: it keeps the focus inside,
 * so its notices are shown in the dialog itself, with `<Notice>`.
 */
export function useNotice(options: { inline?: boolean } = {}) {
  const inline = options.inline === true;
  const [notice, setNotice] = useState<NoticeContent | null>(null);
  const shown = useRef<number | undefined>(undefined);
  return {
    notice: inline ? notice : null,
    show: (content: NoticeContent) => {
      if (inline) {
        setNotice(content);
      } else {
        shown.current = showToast(content);
      }
    },
    showError: (message: string) => {
      if (inline) {
        setNotice({ message, error: true });
      } else {
        shown.current = showToast({ message, error: true });
      }
    },
    clear: () => {
      if (inline) {
        setNotice(null);
      } else if (shown.current !== undefined) {
        dismissToast(shown.current);
      }
    },
  };
}

/**
 * The inline notice of a dialog. The live regions stay mounted while the dialog is shown, because
 * screen readers only announce changes inside a region that already existed. Pages pass the
 * `notice` of a page-level `useNotice`, which is always null: their notices are toasts.
 */
export function Notice({
  notice,
  onDismiss,
  inline = false,
}: {
  notice: NoticeContent | null;
  onDismiss: () => void;
  inline?: boolean;
}) {
  const { t } = useI18n();
  if (!inline) {
    return null;
  }
  const body =
    notice === null ? null : (
      <div className={notice.error === true ? "notice notice--danger" : "notice"}>
        <Icon name={notice.error === true ? "alert" : "check"} />
        <div className="admin-notice__text">{notice.message}</div>
        {notice.undo === undefined ? null : (
          <button
            type="button"
            className="admin-link-button"
            onClick={() => {
              const undo = notice.undo;
              onDismiss();
              undo?.();
            }}
          >
            {t("admin.common.undo")}
          </button>
        )}
        <button type="button" className="admin-link-button" onClick={onDismiss}>
          {t("admin.common.dismiss")}
        </button>
      </div>
    );
  return (
    <div className="admin-notice">
      <div role="status" aria-atomic="true">
        {notice?.error === true ? null : body}
      </div>
      <div role="alert" aria-atomic="true">
        {notice?.error === true ? body : null}
      </div>
    </div>
  );
}
