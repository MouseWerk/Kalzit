import { useEffect, useState } from "react";
import { Icon } from "../../../components/Icon";
import { useI18n } from "../../../i18n/i18n";

export interface NoticeContent {
  message: string;
  /** Offered as "Undo" next to the message; the change it reverts is already saved. */
  undo?: (() => void) | undefined;
  /** An error is announced assertively and drawn with the danger tint. */
  error?: boolean;
}

// A notice for the next page, when a change ends with a navigation (a created role opens).
let flash: NoticeContent | null = null;

/** Shows `content` on the next page that uses `useNotice`. */
export function setFlash(content: NoticeContent): void {
  flash = content;
}

// Read during the first render and cleared after it, so a render that runs twice (strict mode)
// still sees it.
function peekFlash(): NoticeContent | null {
  return flash;
}

/**
 * Changes apply at once; the page confirms each with a notice that offers to undo it, and reports
 * a failed change in the same place. The next change replaces the notice.
 */
export function useNotice() {
  const [notice, setNotice] = useState<NoticeContent | null>(peekFlash);
  useEffect(() => {
    flash = null;
  }, []);
  return {
    notice,
    show: (content: NoticeContent) => setNotice(content),
    showError: (message: string) => setNotice({ message, error: true }),
    clear: () => setNotice(null),
  };
}

/**
 * The live regions stay mounted while the page is shown, because screen readers only announce
 * changes inside a region that already existed.
 */
export function Notice({
  notice,
  onDismiss,
}: {
  notice: NoticeContent | null;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
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
