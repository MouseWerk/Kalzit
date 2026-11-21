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
import { hasMessage, useI18n } from "../../../i18n/i18n";
import { errorReason, reasonText } from "../../datasources/reasons";
import { adminKeys, listServerSettings } from "../api";
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
 * A request belongs to no organization and has no role until it is decided: approving here adds
 * the person to this page's organization, with the default role of the registration settings
 * unless another one is picked.
 */
export function PendingRegistrations({ orgId }: { orgId: string }) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const notice = useNotice();
  const headingId = useId();
  const list = useQuery({ queryKey: registrationsKey, queryFn: listPendingRegistrations });
  const settings = useQuery({ queryKey: adminKeys.serverSettings, queryFn: listServerSettings });
  const configured = settings.data?.find((s) => s.key === "registration.default_role")?.value;
  const defaultRole = ROLES.find((role) => role === configured) ?? "viewer";
  // The role each request is approved with, where it differs from the default one.
  const [roles, setRoles] = useState<Record<string, string>>({});
  const roleOf = (request: Registration) => roles[request.id] ?? request.role ?? defaultRole;
  const [declining, setDeclining] = useState<Registration | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: registrationsKey });
    await queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });
  };
  const failure = (error: unknown) => {
    const reason = errorReason(error);
    const key = `serverAdmin.reason.${(reason?.reason ?? "").replace(/^signup\./, "")}`;
    return hasMessage(key)
      ? t(key)
      : ((reason === undefined ? undefined : reasonText(t, reason)) ?? errorText(t, error));
  };
  const approve = useMutation({
    mutationFn: (request: Registration) => approveRegistration(request.id, orgId, roleOf(request)),
    onSuccess: async (_, request) => {
      await refresh();
      notice.show({ message: t("serverAdmin.requests.approved", { name: request.name }) });
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
      notice.show({ message: t("serverAdmin.requests.declined", { name: request.name }) });
    },
  });
  const items = list.data ?? [];
  if (items.length === 0) {
    return <Notice notice={notice.notice} onDismiss={notice.clear} />;
  }
  return (
    <>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      <section className="admin-table-card invitations" aria-labelledby={headingId}>
        <div className="invitations__head signups__head">
          <h3 id={headingId} className="invitations__heading">
            {t("serverAdmin.requests.title")}
            <span className="admin-badge">{items.length}</span>
          </h3>
          <p className="invitations__lead">{t("serverAdmin.requests.lead")}</p>
        </div>
        <table className="admin-table signups" aria-label={t("serverAdmin.requests.title")}>
          <thead>
            <tr>
              <th scope="col">{t("admin.members.colPerson")}</th>
              <th scope="col">{t("serverAdmin.requests.asked")}</th>
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
                  <span className="signups__name">{request.name}</span>
                  <span className="signups__address">{request.email}</span>
                </td>
                <td className="admin-table__nowrap">
                  {formatDateTime(request.confirmedAt ?? request.createdAt, language, timeZone)}
                </td>
                <td>
                  <Select
                    value={roleOf(request)}
                    aria-label={t("serverAdmin.requests.roleFor", { name: request.name })}
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
                  {/* Hairline and ghost: the page's one filled button stays "Invite". */}
                  <div className="signups__actions">
                    <button
                      type="button"
                      className="button button--secondary button--small"
                      disabled={approve.isPending || settings.isPending}
                      onClick={() => approve.mutate(request)}
                    >
                      {t("serverAdmin.requests.approve")}
                    </button>
                    <button
                      type="button"
                      className="button button--ghost button--small"
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
        alert
        open={declining !== null}
        title={t("serverAdmin.requests.declineTitle", { name: declining?.name ?? "" })}
        confirmLabel={t("sso.unmapped.refuse")}
        busy={decline.isPending}
        error={decline.isError ? failure(decline.error) : undefined}
        onConfirm={() => {
          if (declining !== null) decline.mutate(declining);
        }}
        onClose={() => setDeclining(null)}
      >
        {t("serverAdmin.requests.declineText")}
      </ConfirmDialog>
    </>
  );
}
