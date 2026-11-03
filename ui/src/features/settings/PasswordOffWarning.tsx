import { useState } from "react";
import { useI18n } from "../../i18n/i18n";
import { listPasswordOnlyAdmins, type PasswordOnlyAdmin } from "../admin/api";
import { ConfirmDialog } from "../admin/components/Dialog";
import { ChangeCancelled } from "../admin/components/Settings";

interface Waiting {
  people: PasswordOnlyAdmin[];
  resolve: () => void;
  reject: (error: unknown) => void;
}

/**
 * Before an organization turns password sign-in off (`signin.local_password` = `off`): the owners
 * and administrators who have no sign-in through a provider or directory into it are listed, and
 * the change goes through only once the admin confirms it. They could no longer enter the
 * organization; a server admin puts the rule back for them (docs/api/access.md, "Organization
 * sign-in rules"). Render `dialog` next to the caller; `check` resolves when the change may go on
 * and fails with `ChangeCancelled` when the admin called it off.
 */
export function usePasswordOffWarning(orgId: string) {
  const { t } = useI18n();
  const [waiting, setWaiting] = useState<Waiting | null>(null);

  async function check(key: string, value: unknown): Promise<void> {
    if (key !== "signin.local_password" || value !== "off") {
      return;
    }
    const people = await listPasswordOnlyAdmins(orgId);
    if (people.length === 0) {
      return;
    }
    await new Promise<void>((resolve, reject) => setWaiting({ people, resolve, reject }));
  }

  const dialog =
    waiting === null ? null : (
      <ConfirmDialog
        open
        title={t("settings.orgRules.passwordOffTitle")}
        confirmLabel={t("settings.orgRules.passwordOffConfirm")}
        onClose={() => {
          waiting.reject(new ChangeCancelled());
          setWaiting(null);
        }}
        onConfirm={() => {
          waiting.resolve();
          setWaiting(null);
        }}
      >
        <p>{t("settings.orgRules.passwordOffText")}</p>
        <ul aria-label={t("settings.orgRules.passwordOffList")}>
          {waiting.people.map((person) => (
            <li key={person.userId}>
              {t("settings.orgRules.passwordOffPerson", { name: person.name, email: person.email })}
            </li>
          ))}
        </ul>
        <p>{t("settings.orgRules.passwordOffRecovery")}</p>
      </ConfirmDialog>
    );

  return { check, dialog };
}
