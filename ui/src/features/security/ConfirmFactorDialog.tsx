import { useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { isApiError } from "../../api/client";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { errorText } from "../admin/errors";
import {
  confirmFactor,
  confirmPasskeyOptions,
  type FactorMethod,
  type SecurityStatus,
  securityKeys,
} from "./api";
import { FactorForm } from "./FactorForm";

/** The methods a status offers for a confirmation. */
export function methodsOf(status: SecurityStatus): FactorMethod[] {
  return [
    ...(status.passkeys.length > 0 ? (["passkey"] as const) : []),
    ...(status.totp !== null ? (["totp"] as const) : []),
    ...((status.recoveryCodes?.remaining ?? 0) > 0 ? (["recovery"] as const) : []),
  ];
}

/** Whether the session's last confirmation still allows changes, a few seconds to spare. */
export function isConfirmed(status: SecurityStatus): boolean {
  return status.confirmedUntil !== null && status.confirmedUntil - 5_000 > Date.now();
}

/**
 * A change that needs a fresh confirmation with the second factor (frames 4E, 4F and 7D): the
 * dialog says what happens, asks for a factor unless the session confirmed one in the last
 * minutes, then runs `action`. An action refused with `confirmation_required` asks again.
 */
export function ConfirmFactorDialog({
  open,
  title,
  children,
  confirmLabel,
  status,
  action,
  onClose,
  extra,
  describeError,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  status: SecurityStatus;
  action: () => Promise<void>;
  onClose: () => void;
  /** More fields above the confirmation, such as a reason. */
  extra?: ReactNode;
  /** The text of a failed action, where the general one says too little. */
  describeError?: (failure: unknown) => string | undefined;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [askAgain, setAskAgain] = useState(false);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const textId = useId();
  const confirmed = isConfirmed(status) && !askAgain;

  async function run() {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (failure) {
      if (isApiError(failure, "confirmation_required")) {
        setAskAgain(true);
      } else {
        setError(describeError?.(failure) ?? errorText(t, failure));
      }
    } finally {
      setBusy(false);
    }
  }

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
            {t("security.dialog.cancel")}
          </button>
          {confirmed ? (
            <button
              type="button"
              className="button button--danger"
              aria-disabled={busy}
              onClick={() => {
                if (!busy) {
                  void run();
                }
              }}
            >
              {confirmLabel}
            </button>
          ) : null}
        </>
      }
    >
      <div id={textId} className="admin-dialog__text">
        {children}
      </div>
      {extra}
      {confirmed ? null : (
        <>
          <p className="admin-dialog__text">{t("security.dialog.confirmFirst")}</p>
          <FactorForm
            methods={methodsOf(status)}
            passkeyOptions={confirmPasskeyOptions}
            submitLabel={confirmLabel}
            submit={async (proof) => {
              await confirmFactor(proof);
              setAskAgain(false);
              void queryClient.invalidateQueries({ queryKey: securityKeys.status });
              await run();
            }}
          />
        </>
      )}
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
    </Dialog>
  );
}
