import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { FormAlert } from "../../components/FormAlert";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { AI_STATUS_QUERY_KEY, acknowledgeAiNotice } from "./api";
import { aiErrorText } from "./reasons";
import { useAiStatusFor } from "./useAiStatus";
import "./ai-calls.css";

/** The functions the notice names what they send for. */
export type AiFeature = "explain" | "draft" | "summarize" | "chat";

export interface AiNoticeGate {
  /**
   * Runs `run` once the person acknowledged the notice for the provider in effect; the first
   * time, it shows the notice and runs after "Got it". The server refuses calls before that.
   */
  guard: (feature: AiFeature, run: () => void, onCancel?: () => void) => void;
  /** The dialog, to be rendered where the gate is used. */
  dialog: ReactNode;
}

/**
 * The first-use notice (board frame 7, "Bevor du KI nutzt"): which data of this function goes
 * to which provider and host, that answers can be wrong, what never leaves, and the paragraph
 * the administrators added (`ai.notice_text`). Once per person and provider.
 */
export function useAiNotice(orgId: string): AiNoticeGate {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const { status } = useAiStatusFor(orgId);
  const [pending, setPending] = useState<{
    feature: AiFeature;
    run: () => void;
    onCancel: (() => void) | undefined;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const textId = useId();

  function guard(feature: AiFeature, run: () => void, onCancel?: () => void) {
    if (status?.noticeAcknowledged === false) {
      setError(null);
      setPending({ feature, run, onCancel });
      return;
    }
    run();
  }

  function cancel() {
    pending?.onCancel?.();
    setPending(null);
  }

  async function acknowledge() {
    const provider = status?.provider;
    if (pending === null || provider === undefined) {
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await acknowledgeAiNotice(orgId, provider.id);
      await queryClient.invalidateQueries({ queryKey: [AI_STATUS_QUERY_KEY, orgId] });
      const { run } = pending;
      setPending(null);
      run();
    } catch (cause) {
      // Another provider came into effect meanwhile: show its notice instead.
      if (isApiError(cause, "conflict")) {
        await queryClient.invalidateQueries({ queryKey: [AI_STATUS_QUERY_KEY, orgId] });
      }
      setError(aiErrorText(t, cause) ?? t("ai.call.error.generic"));
    } finally {
      setBusy(false);
    }
  }

  const provider = status?.provider;
  const rows = status?.maxRowsToModel ?? 0;
  const dialog =
    pending === null || provider === undefined ? null : (
      <Dialog
        open
        title={t("ai.notice.title")}
        onClose={cancel}
        initialFocus={confirmRef}
        describedBy={textId}
        footer={
          <>
            <button type="button" className="button button--secondary" onClick={cancel}>
              {t("ai.notice.cancel")}
            </button>
            <button
              ref={confirmRef}
              type="button"
              className="button button--primary"
              disabled={busy}
              onClick={() => void acknowledge()}
            >
              {t("ai.notice.confirm")}
            </button>
          </>
        }
      >
        <div className="ai-notice">
          <p id={textId}>
            {t(`ai.notice.sends.${pending.feature}`, {
              provider: provider.name,
              host: provider.host,
              rows,
            })}{" "}
            {t("ai.notice.mayBeWrong")}
          </p>
          <dl className="ai-notice__list">
            <dt>{t("ai.notice.never")}</dt>
            <dd>{t("ai.notice.neverText")}</dd>
            <dt>{t("ai.notice.audit")}</dt>
            <dd>{t("ai.notice.auditText")}</dd>
          </dl>
          {status?.noticeText === undefined ? null : (
            <p className="ai-notice__addition">{status.noticeText}</p>
          )}
          <p className="ai-notice__once">{t("ai.notice.once")}</p>
          {error === null ? null : <FormAlert>{error}</FormAlert>}
        </div>
      </Dialog>
    );
  return { guard, dialog };
}
