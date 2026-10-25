import { useBlocker } from "@tanstack/react-router";
import { useLayoutEffect, useRef } from "react";
import { useI18n } from "../../../i18n/i18n";
import { ConfirmDialog } from "./Dialog";

/**
 * Asks before leaving a page with unsaved changes: a dialog for a move inside the app, the
 * browser's own question for a reload or a closed tab. `text` says what would be lost. Returns
 * the dialog to render (null while nothing is blocked) and `release`, for a move the page makes
 * on purpose right after a change (moving the item to the trash).
 */
export function useLeaveGuard(dirty: boolean, text: string) {
  const { t } = useI18n();
  // Read when a navigation starts, so a save that just cleared it lets the move through.
  const dirtyRef = useRef(dirty);
  useLayoutEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  const blocker = useBlocker({
    // Moving within the page (another section of it) keeps what was typed.
    shouldBlockFn: ({ current, next }) => dirtyRef.current && current.pathname !== next.pathname,
    enableBeforeUnload: () => dirtyRef.current,
    withResolver: true,
  });
  const release = () => {
    dirtyRef.current = false;
  };
  if (blocker.status !== "blocked") {
    return { dialog: null, release };
  }
  const dialog = (
    <ConfirmDialog
      title={t("dashboards.leave.title")}
      confirmLabel={t("dashboards.leave.confirm")}
      onCancel={() => blocker.reset()}
      onConfirm={() => blocker.proceed()}
    >
      {text}
    </ConfirmDialog>
  );
  return { dialog, release };
}
