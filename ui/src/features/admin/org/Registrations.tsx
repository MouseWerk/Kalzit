import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import {
  approveRegistration,
  listPendingRegistrations,
  type Registration,
  registrationsKey,
  rejectRegistration,
} from "../../../auth/registrationApi";
import { Select } from "../../../components/Select";
import { useI18n } from "../../../i18n/i18n";
import { errorReason, reasonText } from "../../datasources/reasons";
import { adminKeys } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { formatDateTime } from "../components/format";
import { Notice, useNotice } from "../components/Notice";
import { errorText } from "../errors";
import "./invitations.css";

const ROLES = ["viewer", "editor"] as const;

/**
 * Requests from self-registration above the members (board Settings075.dc.html, frame 5): people
 * who confirmed their address and wait for a decision. A server admin approves each with a role
 * of at most editor, or declines it; an address that never confirmed its mail is not listed.
 */
export function PendingRegistrations({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const headingId = useId();
  const list = useQuery({ queryKey: registrationsKey, queryFn: listPendingRegistrations });
  // The role each request is approved with, where it differs from the one it asked for.
  const [roles, setRoles] = useState<Record<string, string>>({});
  const [declining, setDeclining] = useState<Registration | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: registrationsKey });
    await queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });
  };
  const failure = (error: unknown) => {
    const reason = errorReason(error);
    return (reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error);
  };
  const approve = useMutation({
    mutationFn: (request: Registration) =>
      approveRegistration(request.id, roles[request.id] ?? request.role ?? "viewer"),
    onSuccess: async (_, request) => {
      await refresh();
      notice.show({ message: t("admin.signups.approved", { name: request.name }) });
    },
    onError: (error) => {
      notice.showError(failure(error));
      void refresh();
    },
  });
  const decline = useMutation({
    mutationFn: (request: Registration) => rejectRegistration(request.id),
    onSuccess: async (_, request) => {
      setDeclining(null);
      await refresh();
      notice.show({ message: t("admin.signups.declined", { name: request.name }) });
    },
  });
  // Requests of other organizations are decided by the admins who work there.
  const items = (list.data ?? []).filter(
    (request) => request.orgId === null || request.orgId === orgId,
  );
  if (items.length === 0) {
    return <Notice notice={notice.notice} onDismiss={notice.clear} />;
  }
  return (
    <>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <section className="admin-table-card invitations" aria-labelledby={headingId}>
        <div className="invitations__head">
          <h3 id={headingId} className="invitations__heading">
            {t("admin.signups.title")}
            <span className="admin-badge">{items.length}</span>
          </h3>
          <p className="invitations__lead">{t("admin.signups.lead")}</p>
        </div>
        <table className="admin-table" aria-label={t("admin.signups.title")}>
          <thead>
            <tr>
              <th scope="col">{t("admin.members.colPerson")}</th>
              <th scope="col">{t("admin.signups.asked")}</th>
              <th scope="col">{t("admin.members.colRole")}</th>
              <th scope="col">
                <span className="visually-hidden">{t("admin.members.colActions")}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((request) => (
              <tr key={request.id} className="admin-table__row">
                <td>
                  {request.name}
                  <span className="admin-table__muted invitations__detail">{request.email}</span>
                </td>
                <td className="admin-table__nowrap">
                  {formatDateTime(request.confirmedAt ?? request.createdAt, language, timeZone)}
                </td>
                <td>
                  <Select
                    value={roles[request.id] ?? request.role ?? "viewer"}
                    aria-label={t("admin.signups.roleFor", { name: request.name })}
                    onChange={(role) => setRoles((current) => ({ ...current, [request.id]: role }))}
                  >
                    {ROLES.map((role) => (
                      <option key={role} value={role}>
                        {t(`admin.role.${role}`)}
                      </option>
                    ))}
                  </Select>
                </td>
                <td className="admin-table__actions">
                  <div className="admin-row__actions">
                    <button
                      type="button"
                      className="button button--primary button--small"
                      disabled={approve.isPending}
                      onClick={() => approve.mutate(request)}
                    >
                      {t("admin.signups.approve")}
                    </button>
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      onClick={() => {
                        decline.reset();
                        setDeclining(request);
                      }}
                    >
                      {t("sso.unmapped.refuse")}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <ConfirmDialog
        open={declining !== null}
        title={t("admin.signups.declineTitle", { name: declining?.name ?? "" })}
        confirmLabel={t("sso.unmapped.refuse")}
        busy={decline.isPending}
        error={decline.isError ? failure(decline.error) : undefined}
        onConfirm={() => {
          if (declining !== null) decline.mutate(declining);
        }}
        onClose={() => setDeclining(null)}
      >
        {t("admin.signups.declineText")}
      </ConfirmDialog>
    </>
  );
}
