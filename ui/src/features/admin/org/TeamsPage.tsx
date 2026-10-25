import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import { adminKeys, createTeam, deleteTeam, listTeams, type Team } from "../api";
import { ConfirmDialog } from "../components/Dialog";
import { usePagedList } from "../components/lists";
import { NameDialog } from "../components/NameDialog";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText, TEAM_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { holdsRole, useRoles } from "./shared";

export function TeamsPage() {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("teams:read");
  const canWrite = access.has("teams:write");
  const list = usePagedList(adminKeys.teams(orgId), (cursor) => listTeams(orgId, cursor), canRead);
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const notice = useNotice();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Team | null>(null);
  // Who takes over the team's spaces, folders and dashboards: the organization or another team.
  const [transferTo, setTransferTo] = useState("org");
  const transferId = useId();
  const teams = list.items ?? [];
  const keys = useRowKeys(teams.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.org(orgId) });

  const remove = useMutation({
    mutationFn: (team: Team) => deleteTeam(orgId, team.id, transferTo),
    onSuccess: async (_, team) => {
      setDeleting(null);
      await refresh();
      notice.show({ message: t("admin.teams.deleted", { name: team.name }) });
    },
  });

  return (
    <Section
      title="admin.teams.title"
      lead="admin.teams.lead"
      allowed={allowedWhen(access, canRead)}
      actions={
        canWrite ? (
          <button
            type="button"
            className="button button--primary"
            onClick={() => setCreating(true)}
          >
            {t("admin.teams.create")}
          </button>
        ) : undefined
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {list.items === undefined ? (
        <LoadState error={list.query.error} onRetry={() => void list.query.refetch()} />
      ) : teams.length === 0 ? (
        <p className="admin-empty">{t("admin.teams.empty")}</p>
      ) : (
        <ul className="admin-list" aria-label={t("admin.teams.title")} {...keys.listProps}>
          {teams.map((team, index) => (
            <li key={team.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <Link
                  to="/admin/teams/$teamId"
                  params={{ teamId: team.id }}
                  className="admin-row__title"
                >
                  {team.name}
                </Link>
                <span className="admin-row__meta">
                  {t(team.memberCount === 1 ? "admin.teams.memberOne" : "admin.teams.memberMany", {
                    count: team.memberCount,
                  })}
                </span>
              </div>
              {/* Deleting takes the team's roles from its members; that needs holding them. */}
              {canWrite && team.roles.every((role) => holdsRole(access, role, roles.data)) ? (
                <div className="admin-row__actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={t("admin.teams.deleteNamed", { name: team.name })}
                    onClick={() => {
                      remove.reset();
                      setTransferTo("org");
                      setDeleting(team);
                    }}
                  >
                    {t("admin.common.deleteAsk")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {list.hasMore ? (
        <button type="button" className="button button--secondary" onClick={list.loadMore}>
          {t("admin.common.showMore")}
        </button>
      ) : null}
      {creating ? (
        <NameDialog
          open
          title={t("admin.teams.createTitle")}
          label={t("admin.teams.name")}
          submitLabel={t("admin.teams.createSubmit")}
          errors={TEAM_ERRORS}
          onClose={() => setCreating(false)}
          onSubmit={async (name) => {
            await createTeam(orgId, name);
            await refresh();
            notice.show({ message: t("admin.teams.created", { name }) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        title={t("admin.teams.deleteTitle")}
        confirmLabel={t("admin.common.delete")}
        busy={remove.isPending}
        error={remove.error === null ? null : errorText(t, remove.error, TEAM_ERRORS)}
        onClose={() => setDeleting(null)}
        onConfirm={() => {
          if (deleting !== null) {
            remove.mutate(deleting);
          }
        }}
      >
        <p>{t("admin.teams.deleteText", { name: deleting?.name ?? "" })}</p>
        <div className="field">
          <label className="field__label" htmlFor={transferId}>
            {t("admin.teams.transferTo")}
          </label>
          <select
            id={transferId}
            className="select"
            value={transferTo}
            onChange={(event) => setTransferTo(event.currentTarget.value)}
          >
            <option value="org">{t("admin.teams.transferToOrg")}</option>
            {teams
              .filter((team) => team.id !== deleting?.id)
              .map((team) => (
                <option key={team.id} value={team.id}>
                  {team.name}
                </option>
              ))}
          </select>
          <p className="field__hint">{t("admin.teams.transferHint")}</p>
        </div>
      </ConfirmDialog>
    </Section>
  );
}
