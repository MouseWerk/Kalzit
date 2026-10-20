import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  fetchTeam,
  listMembers,
  listTeamMembers,
  MAX_PAGE_SIZE,
  putTeamMember,
  removeTeamMember,
  renameTeam,
  setTeamRoles,
  TEAM_ROLES,
  type TeamMember,
  type TeamRole,
} from "../api";
import { roleLabel } from "../catalog";
import { ConfirmDialog, Dialog } from "../components/Dialog";
import { usePagedList } from "../components/lists";
import { NameDialog } from "../components/NameDialog";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText, GRANT_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { canGrant, useRoles } from "./shared";

const TEAM_ROLE_TEXT = {
  member: "admin.teams.teamRole.member",
  maintainer: "admin.teams.teamRole.maintainer",
} as const;

/** One team: its members with their team role, and the roles the team gives its members. */
export function TeamPage({ teamId }: { teamId: string }) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("teams:read");
  const canWrite = access.has("teams:write");
  const canManageMembers = access.has("teams:members");
  const team = useQuery({
    queryKey: adminKeys.team(orgId, teamId),
    queryFn: () => fetchTeam(orgId, teamId),
    enabled: canRead && orgId !== "",
  });
  const members = usePagedList(
    [...adminKeys.team(orgId, teamId), "members"],
    (cursor) => listTeamMembers(orgId, teamId, cursor),
    canRead && orgId !== "",
  );
  const roles = useRoles(access.orgId, access.has("roles:read"));
  const notice = useNotice();
  const [renaming, setRenaming] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);
  const rows = members.items ?? [];
  const keys = useRowKeys(rows.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.teams(orgId) });

  const changeTeamRole = useMutation({
    mutationFn: (input: { member: TeamMember; teamRole: TeamRole; undo: boolean }) =>
      putTeamMember(orgId, teamId, input.member.userId, input.teamRole),
    onSuccess: async (_, { member, teamRole, undo }) => {
      await refresh();
      const message = t("admin.teams.teamRoleChanged", {
        name: member.name,
        role: t(TEAM_ROLE_TEXT[teamRole]),
      });
      notice.show(
        undo
          ? { message }
          : {
              message,
              undo: () =>
                changeTeamRole.mutate({
                  member: { ...member, teamRole },
                  teamRole: member.teamRole,
                  undo: true,
                }),
            },
      );
    },
    onError: (error) => notice.showError(errorText(t, error)),
  });

  const remove = useMutation({
    mutationFn: (member: TeamMember) => removeTeamMember(orgId, teamId, member.userId),
    onSuccess: async (_, member) => {
      setRemoving(null);
      await refresh();
      notice.show({ message: t("admin.teams.memberRemoved", { name: member.name }) });
    },
  });

  const assigned = team.data?.roles ?? [];
  const changeRoles = useMutation({
    mutationFn: (input: { next: string[]; previous: string[]; undo: boolean }) =>
      setTeamRoles(orgId, teamId, input.next),
    onSuccess: async (_, { next, previous, undo }) => {
      await refresh();
      const message = t("admin.teams.rolesChanged");
      notice.show(
        undo
          ? { message }
          : {
              message,
              undo: () => changeRoles.mutate({ next: previous, previous: next, undo: true }),
            },
      );
    },
    onError: (error) => notice.showError(errorText(t, error, GRANT_ERRORS)),
  });

  const back = (
    <Link to="/admin/teams" className="admin-back">
      {t("admin.teams.back")}
    </Link>
  );

  return (
    <Section
      title="admin.teams.title"
      heading={team.data?.name}
      back={back}
      allowed={allowedWhen(access, canRead)}
      actions={
        canWrite && team.data !== undefined ? (
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setRenaming(true)}
          >
            {t("admin.teams.rename")}
          </button>
        ) : undefined
      }
    >
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {team.data === undefined ? (
        <LoadState error={team.error} onRetry={() => void team.refetch()} />
      ) : (
        <>
          <div className="admin-subsection">
            <div className="admin-subsection__header">
              <h3>{t("admin.teams.members")}</h3>
              {canManageMembers && access.has("users:read") ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setAdding(true)}
                >
                  {t("admin.teams.addMember")}
                </button>
              ) : null}
            </div>
            {members.items === undefined ? (
              <LoadState error={members.query.error} onRetry={() => void members.query.refetch()} />
            ) : rows.length === 0 ? (
              <p className="admin-empty">{t("admin.teams.noMembers")}</p>
            ) : (
              <ul className="admin-list" aria-label={t("admin.teams.members")} {...keys.listProps}>
                {rows.map((member, index) => (
                  <li key={member.userId} className="admin-row" {...keys.rowProps(index)}>
                    <div className="admin-row__main">
                      <span className="admin-row__title">{member.name}</span>
                      <span className="admin-row__meta">{member.email}</span>
                    </div>
                    <div className="admin-row__actions">
                      {canManageMembers ? (
                        <>
                          <select
                            className="select"
                            aria-label={t("admin.teams.teamRoleOf", { name: member.name })}
                            value={member.teamRole}
                            disabled={changeTeamRole.isPending}
                            onChange={(event) => {
                              const teamRole = TEAM_ROLES.find(
                                (role) => role === event.currentTarget.value,
                              );
                              if (teamRole !== undefined) {
                                changeTeamRole.mutate({ member, teamRole, undo: false });
                              }
                            }}
                          >
                            {TEAM_ROLES.map((role) => (
                              <option key={role} value={role}>
                                {t(TEAM_ROLE_TEXT[role])}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="button button--secondary"
                            aria-label={t("admin.teams.removeMemberNamed", { name: member.name })}
                            onClick={() => {
                              remove.reset();
                              setRemoving(member);
                            }}
                          >
                            {t("admin.common.removeAsk")}
                          </button>
                        </>
                      ) : (
                        <span className="admin-badge">{t(TEAM_ROLE_TEXT[member.teamRole])}</span>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {members.hasMore ? (
              <button type="button" className="button button--secondary" onClick={members.loadMore}>
                {t("admin.common.showMore")}
              </button>
            ) : null}
          </div>

          <fieldset className="admin-subsection admin-fieldset">
            <legend>
              <h3>{t("admin.teams.roles")}</h3>
            </legend>
            <p className="admin-section__lead">{t("admin.teams.rolesLead")}</p>
            {roles.data === undefined ? (
              <ul className="admin-tags">
                {assigned.map((role) => (
                  <li key={role} className="admin-badge">
                    {roleLabel(t, role, undefined)}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="admin-checks">
                {roles.data.map((role) => {
                  const checked = assigned.includes(role.id);
                  const allowed = canGrant(access, role);
                  return (
                    <label key={role.id} className="admin-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={!canWrite || changeRoles.isPending || (!allowed && !checked)}
                        onChange={() =>
                          changeRoles.mutate({
                            next: checked
                              ? assigned.filter((id) => id !== role.id)
                              : [...assigned, role.id],
                            previous: assigned,
                            undo: false,
                          })
                        }
                      />
                      <span>{roleLabel(t, role.id, roles.data)}</span>
                    </label>
                  );
                })}
              </div>
            )}
          </fieldset>
        </>
      )}
      {renaming && team.data !== undefined ? (
        <NameDialog
          open
          title={t("admin.teams.renameTitle")}
          label={t("admin.teams.name")}
          initial={team.data.name}
          submitLabel={t("admin.common.save")}
          errors={{ conflict: "admin.teams.nameTaken" }}
          onClose={() => setRenaming(false)}
          onSubmit={async (name) => {
            await renameTeam(orgId, teamId, name);
            await refresh();
            notice.show({ message: t("admin.teams.renamed", { name }) });
          }}
        />
      ) : null}
      {adding ? (
        <AddTeamMemberDialog
          orgId={orgId}
          teamId={teamId}
          present={rows.map((member) => member.userId)}
          onClose={() => setAdding(false)}
          onAdded={async (name) => {
            setAdding(false);
            await refresh();
            notice.show({ message: t("admin.teams.memberAdded", { name }) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={t("admin.teams.removeMemberTitle")}
        confirmLabel={t("admin.common.remove")}
        busy={remove.isPending}
        error={remove.error === null ? null : errorText(t, remove.error)}
        onClose={() => setRemoving(null)}
        onConfirm={() => {
          if (removing !== null) {
            remove.mutate(removing);
          }
        }}
      >
        {t("admin.teams.removeMemberText", {
          name: removing?.name ?? "",
          team: team.data?.name ?? "",
        })}
      </ConfirmDialog>
    </Section>
  );
}

function AddTeamMemberDialog({
  orgId,
  teamId,
  present,
  onClose,
  onAdded,
}: {
  orgId: string;
  teamId: string;
  present: readonly string[];
  onClose: () => void;
  onAdded: (name: string) => void;
}) {
  const { t } = useI18n();
  const memberId = useId();
  const roleId = useId();
  const candidates = useQuery({
    queryKey: [...adminKeys.members(orgId), "picker"],
    queryFn: () => listMembers(orgId, undefined, MAX_PAGE_SIZE),
  });
  const options = (candidates.data?.items ?? []).filter(
    (member) => !present.includes(member.userId),
  );
  const [userId, setUserId] = useState("");
  const [teamRole, setTeamRole] = useState<TeamRole>("member");
  const chosen = userId === "" ? options[0]?.userId : userId;
  const add = useMutation({
    mutationFn: (id: string) => putTeamMember(orgId, teamId, id, teamRole),
    onSuccess: (_, id) => onAdded(options.find((member) => member.userId === id)?.name ?? id),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen !== undefined && !add.isPending) {
      add.mutate(chosen);
    }
  }

  return (
    <Dialog open title={t("admin.teams.addMemberTitle")} onClose={onClose}>
      {candidates.data === undefined ? (
        <LoadState error={candidates.error} onRetry={() => void candidates.refetch()} />
      ) : options.length === 0 ? (
        <p>{t("admin.teams.everyoneIn")}</p>
      ) : (
        <form className="form" noValidate onSubmit={submit}>
          <div className="field">
            <label className="field__label" htmlFor={memberId}>
              {t("admin.teams.member")}
            </label>
            <select
              id={memberId}
              className="select"
              value={chosen}
              onChange={(event) => setUserId(event.currentTarget.value)}
            >
              {options.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {t("admin.common.nameAndEmail", { name: member.name, email: member.email })}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label className="field__label" htmlFor={roleId}>
              {t("admin.teams.teamRole")}
            </label>
            <select
              id={roleId}
              className="select"
              value={teamRole}
              onChange={(event) => {
                const next = TEAM_ROLES.find((role) => role === event.currentTarget.value);
                if (next !== undefined) {
                  setTeamRole(next);
                }
              }}
            >
              {TEAM_ROLES.map((role) => (
                <option key={role} value={role}>
                  {t(TEAM_ROLE_TEXT[role])}
                </option>
              ))}
            </select>
            <p className="field__hint">{t("admin.teams.teamRoleHint")}</p>
          </div>
          {add.error === null ? null : (
            <p className="admin-error" role="alert">
              {errorText(t, add.error)}
            </p>
          )}
          <div className="admin-dialog__footer">
            <button type="button" className="button button--secondary" onClick={onClose}>
              {t("admin.common.cancel")}
            </button>
            <button type="submit" className="button button--primary" aria-disabled={add.isPending}>
              {t("admin.teams.addMemberSubmit")}
            </button>
          </div>
        </form>
      )}
    </Dialog>
  );
}
