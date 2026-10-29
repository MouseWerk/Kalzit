import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { Dialog } from "../admin/components/Dialog";
import { fetchSecurity, reasonOf, type SecondFactorSummary, securityKeys } from "./api";
import { ConfirmFactorDialog, methodsOf } from "./ConfirmFactorDialog";
import "./security.css";

/** A person's second factor in a list of people (frame 7): methods, missing, or locked. */
export function SecondFactorBadge({ summary }: { summary: SecondFactorSummary | undefined }) {
  const { t, language } = useI18n();
  if (summary === undefined) {
    return null;
  }
  const methods = summary.methods
    .map((method) => (method === "passkey" ? t("security.admin.passkey") : t("security.admin.app")))
    .join(", ");
  let text = methods;
  if (summary.methods.length === 0) {
    text = summary.required ? t("security.admin.missing") : t("security.admin.none");
  }
  return (
    <span
      className={
        summary.methods.length === 0 && summary.required
          ? "security-status security-status--missing"
          : "security-status"
      }
      title={
        summary.methods.length === 0 && summary.required
          ? t("security.admin.missingHint")
          : undefined
      }
    >
      {summary.methods.length === 0 && summary.required ? <Icon name="alert" /> : null}
      <span className="visually-hidden">{t("security.admin.label")}: </span>
      {text}
      {summary.lockedUntil === null ? null : (
        <>
          {" · "}
          {t("security.admin.lockedUntil", {
            time: new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(
              summary.lockedUntil,
            ),
          })}
        </>
      )}
    </span>
  );
}

/**
 * Resetting another person's second factor (frame 7D): what it does, a reason for the audit log,
 * and the admin's own second factor first. Admins without one are told to set one up.
 */
export function ResetSecondFactorDialog({
  name,
  reset,
  onClose,
  onDone,
}: {
  name: string;
  reset: (reason: string) => Promise<void>;
  onClose: () => void;
  onDone: () => void;
}) {
  const { t } = useI18n();
  const own = useQuery({ queryKey: securityKeys.status, queryFn: fetchSecurity });
  const [reason, setReason] = useState("");
  const title = t("security.admin.resetTitle", { name });
  if (own.data === undefined) {
    return (
      <Dialog open title={title} onClose={onClose}>
        <p className="admin-dialog__text">{t("security.dialog.loading")}</p>
      </Dialog>
    );
  }
  if (methodsOf(own.data).filter((m) => m !== "recovery").length === 0) {
    return (
      <Dialog
        open
        title={title}
        onClose={onClose}
        footer={
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("security.dialog.close")}
          </button>
        }
      >
        <p className="admin-dialog__text">{t("security.admin.ownMissing")}</p>
        <Link
          to="/settings/$section"
          params={{ section: "account-security" }}
          className="button button--secondary"
        >
          {t("security.account.setUp")}
        </Link>
      </Dialog>
    );
  }
  return (
    <ConfirmFactorDialog
      open
      title={title}
      confirmLabel={t("security.admin.resetConfirm")}
      status={own.data}
      onClose={onClose}
      describeError={(failure) =>
        reasonOf(failure) === "second_factor.reset_needs_server_admin"
          ? t("security.admin.needsServerAdmin")
          : undefined
      }
      action={async () => {
        await reset(reason.trim());
        onDone();
      }}
      extra={
        <TextField
          label={t("security.admin.reason")}
          value={reason}
          maxLength={200}
          onValueChange={setReason}
        />
      }
    >
      <ul className="security-reset__list">
        <li>{t("security.admin.resetRemoves")}</li>
        <li>{t("security.admin.resetSessions", { name })}</li>
        <li>{t("security.admin.resetNext", { name })}</li>
        <li>{t("security.admin.resetAudit", { name })}</li>
      </ul>
      <p>{t("security.admin.confirmOwn")}</p>
    </ConfirmFactorDialog>
  );
}
