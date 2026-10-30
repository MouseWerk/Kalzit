import { useMutation } from "@tanstack/react-query";
import { expectShape, request } from "../../../api/client";
import { useI18n } from "../../../i18n/i18n";
import { errorReason, reasonText } from "../../datasources/reasons";
import { errorText } from "../errors";
import { isDelivered } from "../invitationsApi";

/** Mails the signed-in user's own address a confirmation link (docs/api/mail.md). */
export async function requestEmailConfirmation() {
  return expectShape(
    await request("POST", "/api/me/email-confirmation", {}),
    isDelivered,
    "email confirmation",
  );
}

/**
 * An address nobody confirmed yet (an account from an invitation link an admin passed on): says
 * what that means and sends the confirmation link.
 */
export function EmailConfirmation({ email }: { email: string }) {
  const { t } = useI18n();
  const send = useMutation({ mutationFn: requestEmailConfirmation, retry: false });
  let status: string | null = null;
  if (send.isSuccess) {
    status = t("admin.account.confirmSent", { email });
  } else if (send.error !== null) {
    const reason = errorReason(send.error);
    status =
      reason?.reason === "mail.reset_unavailable"
        ? t("admin.account.confirmNoMail")
        : ((reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, send.error));
  }
  return (
    <div className="field">
      <p className="field__hint">{t("admin.account.unconfirmed")}</p>
      <div>
        <button
          type="button"
          className="button button--secondary"
          aria-disabled={send.isPending}
          onClick={() => {
            if (!send.isPending) send.mutate();
          }}
        >
          {t("admin.account.confirmSend")}
        </button>
      </div>
      <p className={send.error === null ? "field__hint" : "field__error"} role="status">
        {status}
      </p>
    </div>
  );
}
