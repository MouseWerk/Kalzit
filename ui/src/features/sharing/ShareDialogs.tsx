import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { ConfirmDialog, Dialog } from "../dashboards/ui/Dialog";
import { changeExpiry, revokeShare, SHARING_KEY, type Share, shareOf } from "./api";
import { refusedMaxDays, sharingErrorText } from "./limits";
import {
  DAY_MS,
  dateText,
  durationText,
  fromDateInput,
  kindText,
  shareName,
  toDateInput,
} from "./model";
import "./sharing.css";

/**
 * Asks before a link or snapshot is revoked (board frame 13): revoking is final, so it is an
 * `alertdialog` whose focus starts on Cancel.
 */
export function RevokeDialog({ share, onClose }: { share: Share; onClose: () => void }) {
  const { t, language } = useI18n();
  const queryClient = useQueryClient();
  const item = shareOf(share);
  const name = shareName(t, share);
  const revoke = useMutation({
    mutationFn: () => revokeShare(share),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [SHARING_KEY] });
      showToast({ message: t("sharing.revoke.done", { name }) });
      onClose();
    },
  });
  return (
    <ConfirmDialog
      alert
      title={t("sharing.revoke.title", { name })}
      confirmLabel={t("sharing.revoke.confirm")}
      busy={revoke.isPending}
      error={revoke.isError ? sharingErrorText(t, revoke.error, language) : undefined}
      onConfirm={() => revoke.mutate()}
      onCancel={onClose}
    >
      {t(share.kind === "link" ? "sharing.revoke.textLink" : "sharing.revoke.textSnapshot")}
      <span className="share-confirm__facts">
        <span>
          {item.createdByName === null
            ? kindText(t, share)
            : t("sharing.revoke.by", { kind: kindText(t, share), name: item.createdByName })}
        </span>
        <span>{t("sharing.views", { count: item.views })}</span>
      </span>
    </ConfirmDialog>
  );
}

/**
 * "Ablauf ändern" (board frame 15): a new day up to the longest expiry from today. The problem
 * shows at the field; Save stays available and reports the same reason.
 */
export function ExpiryDialog({
  share,
  maxExpiryDays,
  onClose,
}: {
  share: Share;
  maxExpiryDays: number;
  onClose: () => void;
}) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const fieldId = useId();
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const [now] = useState(() => Date.now());
  const [date, setDate] = useState(() => toDateInput(shareOf(share).expiresAt));
  const [checked, setChecked] = useState(false);
  // The server's own limit, once a refusal named it.
  const [refusedMax, setRefusedMax] = useState<number | undefined>(undefined);
  const maxDays = refusedMax ?? maxExpiryDays;
  const latest = now + maxDays * DAY_MS;
  const chosen = fromDateInput(date);

  const save = useMutation({
    mutationFn: (expiresAt: number) => changeExpiry(share, expiresAt),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [SHARING_KEY] });
      showToast({ message: t("sharing.expiry.saved", { name: shareName(t, share) }) });
      onClose();
    },
    onError: (error) => setRefusedMax(refusedMaxDays(error)),
  });

  let problem: string | undefined;
  if (chosen === undefined) {
    problem = checked ? t("sharing.expiry.invalid") : undefined;
  } else if (chosen <= now) {
    problem = t("sharing.expiry.past");
  } else if (chosen > latest) {
    problem = t("sharing.expiry.tooLate", { date: dateText(latest, language, timeZone) });
  } else if (save.isError && refusedMaxDays(save.error) === undefined) {
    problem = sharingErrorText(t, save.error, language);
  }

  return (
    <Dialog
      title={t("sharing.expiry.title")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={`${fieldId}-form`}
            className="button button--primary"
            disabled={save.isPending}
          >
            {t("sharing.save")}
          </button>
        </>
      }
    >
      <form
        id={`${fieldId}-form`}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setChecked(true);
          if (chosen !== undefined && chosen > now && chosen <= latest) {
            save.mutate(chosen);
          }
        }}
      >
        <div className="field">
          <label className="field__label" htmlFor={fieldId}>
            {t("sharing.expiry.label")}
          </label>
          <input
            id={fieldId}
            type="date"
            className="input"
            value={date}
            min={toDateInput(now + DAY_MS)}
            max={toDateInput(latest)}
            data-autofocus
            aria-invalid={problem === undefined ? undefined : true}
            aria-describedby={problem === undefined ? hintId : `${errorId} ${hintId}`}
            onChange={(event) => {
              setDate(event.currentTarget.value);
              save.reset();
            }}
          />
          {problem === undefined ? null : (
            <p className="field__error" id={errorId} role="alert">
              {problem}
            </p>
          )}
          <p className="field__hint" id={hintId}>
            {t("sharing.expiry.hint", {
              date: dateText(latest, language, timeZone),
              duration: durationText(t, maxDays * DAY_MS),
            })}
          </p>
        </div>
      </form>
    </Dialog>
  );
}
