import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type FormEvent, useId, useState } from "react";
import { useI18n } from "../../../i18n/i18n";
import {
  adminKeys,
  fetchTeam,
  listMembers,
  listTeamMembers,
  MAX_PAGE_SIZE,
  MAX_TEAM_ROLES,
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
import { PagedSelect } from "../components/PagedSelect";
import { useRowKeys } from "../components/rows";
import { LoadState, Section } from "../components/Section";
import { errorText, TEAM_ERRORS } from "../errors";
import { allowedWhen, useAdminAccess } from "../sections";
import { holdsRole, useRoles } from "./shared";

const TEAM_ROLE_TEXT = {
  member: "admin.teams.teamRole.member",
  maintainer: "admin.teams.teamRole.maintainer",
} as const;

const appRoute = getRouteApi("/_app");
const teamRoute = getRouteApi("/_app/admin/teams/$teamId");

/** The team page as a route; keyed, so moving between teams starts with fresh state. */
export function TeamRoutePage() {
  const { teamId } = teamRoute.useParams();
  return <TeamPage key={teamId} teamId={teamId} />;
}

function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  return [...a].sort().join("\n") === [...b].sort().join("\n");
}

/** One team: its members with their team role, and the roles the team gives its members. */
export function TeamPage({ teamId }: { teamId: string }) {
  const { t } = useI18n();
  const access = useAdminAccess();
  const { me } = appRoute.useRouteContext();
  const orgId = access.orgId ?? "";
  const queryClient = useQueryClient();
  const canRead = access.has("teams:read");
  const canWrite = access.has("teams:write");
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
  const assigned = team.data?.roles ?? [];

  // Who joins or leaves the team gains or loses its roles, so changing members needs holding
  // them, plus teams:members or being a maintainer of this team (docs/api/access.md, Teams).
  const isMaintainer = rows.some((row) => row.userId === me.id && row.role === "maintainer");
  const holdsTeamRoles = assigned.every((role) => holdsRole(access, role, roles.data));
  const canManageMembers =
    (access.has("teams:members") || isMaintainer) && holdsTeamRoles && team.data !== undefined;

  const refresh = () => queryClient.invalidateQueries({ queryKey: adminKeys.teams(orgId) });

  // Team memberships carry no version: undo puts back the team role as it was when changed here.
  const changeTeamRole = useMutation({
    mutationFn: (input: { member: TeamMember; role: TeamRole; undo: boolean }) =>
      putTeamMember(orgId, teamId, input.member.userId, input.role),
    onSuccess: async (changed, { member, undo }) => {
      await refresh();
      const message = t("admin.teams.teamRoleChanged", {
        name: member.name,
        role: t(TEAM_ROLE_TEXT[changed.role]),
      });
      notice.show(
        undo
          ? { message }
          : {
              message,
              undo: () => changeTeamRole.mutate({ member: changed, role: member.role, undo: true }),
            },
      );
    },
    onError: (error) => notice.showError(errorText(t, error, TEAM_ERRORS)),
  });

  const remove = useMutation({
    mutationFn: (member: TeamMember) => removeTeamMember(orgId, teamId, member.userId),
    onSuccess: async (_, member) => {
      setRemoving(null);
      await refresh();
      notice.show({ message: t("admin.teams.memberRemoved", { name: member.name }) });
    },
  });

  const changeRoles = useMutation({
    mutationFn: async (input: { next: string[]; previous: string[]; undo: boolean }) => {
      if (input.undo) {
        // Roles carry no version: undo first checks that nobody changed them since.
        const current = await fetchTeam(orgId, teamId);
        if (!sameRoles(current.roles, input.previous)) {
          throw new ChangedMeanwhile();
        }
      }
      return setTeamRoles(orgId, teamId, input.next);
    },
    onSuccess: async (changed, { previous, undo }) => {
      await refresh();
      const message = t(undo ? "admin.teams.rolesRestored" : "admin.teams.rolesChanged");
      notice.show(
        undo
          ? { message }
          : {
              message,
              undo: () =>
                changeRoles.mutate({ next: previous, previous: changed.roles, undo: true }),
            },
      );
    },
    onError: async (error) => {
      if (error instanceof ChangedMeanwhile) {
        await refresh();
        notice.showError(t("admin.common.changedMeanwhile"));
        return;
      }
      notice.showError(errorText(t, error, TEAM_ERRORS));
    },
  });

  const back = (
    <Link to="/admin/teams" className="admin-back">
      {t("admin.teams.back")}
    </Link>
  );

  const offeredRoles = (roles.data ?? []).filter((role) => role.id !== "owner");
  const full = assigned.length >= MAX_TEAM_ROLES;

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
            {!holdsTeamRoles && (access.has("teams:members") || isMaintainer) ? (
              <p className="admin-section__lead">{t("admin.teams.rolesAboveYou")}</p>
            ) : null}
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
                            value={member.role}
                            aria-disabled={changeTeamRole.isPending}
                            onChange={(event) => {
                              const role = TEAM_ROLES.find(
                                (candidate) => candidate === event.currentTarget.value,
                              );
                              if (role !== undefined && !changeTeamRole.isPending) {
                                changeTeamRole.mutate({ member, role, undo: false });
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
                        <span className="admin-badge">{t(TEAM_ROLE_TEXT[member.role])}</span>
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
            <p className="admin-section__lead">
              {t("admin.teams.rolesLead", { count: MAX_TEAM_ROLES })}
            </p>
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
                {offeredRoles.map((role) => {
                  const checked = assigned.includes(role.id);
                  // Giving and taking a team role both need holding its permissions.
                  const held = holdsRole(access, role.id, roles.data);
                  const blocked = !canWrite || !held || (!checked && full);
                  return (
                    <label key={role.id} className="admin-check">
                      <input
                        type="checkbox"
                        checked={checked}
                        disabled={blocked}
                        aria-disabled={changeRoles.isPending}
                        onChange={() => {
                          if (changeRoles.isPending) {
                            return;
                          }
                          changeRoles.mutate({
                            next: checked
                              ? assigned.filter((id) => id !== role.id)
                              : [...assigned, role.id],
                            previous: assigned,
                            undo: false,
                          });
                        }}
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
          errors={TEAM_ERRORS}
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
        error={remove.error === null ? null : errorText(t, remove.error, TEAM_ERRORS)}
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

/** Undo found the value changed by someone else since the change it would revert. */
class ChangedMeanwhile extends Error {}

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
  const formId = useId();
  const memberId = useId();
  const roleId = useId();
  const candidates = usePagedList([...adminKeys.members(orgId), "picker"], (cursor) =>
    listMembers(orgId, cursor, MAX_PAGE_SIZE),
  );
  const options = candidates.items
    ?.filter((member) => !present.includes(member.userId))
    .map((member) => ({
      id: member.userId,
      label: t("admin.common.nameAndEmail", { name: member.name, email: member.email }),
    }));
  const [userId, setUserId] = useState("");
  const [role, setRole] = useState<TeamRole>("member");
  const chosen = options?.find((option) => option.id === userId) ?? options?.[0];
  const add = useMutation({
    mutationFn: (id: string) => putTeamMember(orgId, teamId, id, role),
    onSuccess: (added) => onAdded(added.name),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (chosen !== undefined && !add.isPending) {
      add.mutate(chosen.id);
    }
  }

  const empty = options !== undefined && options.length === 0 && !candidates.hasMore;
  return (
    <Dialog
      open
      title={t("admin.teams.addMemberTitle")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("admin.common.cancel")}
          </button>
          {options === undefined || empty ? null : (
            <button
              type="submit"
              form={formId}
              className="button button--primary"
              aria-disabled={add.isPending || chosen === undefined}
            >
              {t("admin.teams.addMemberSubmit")}
            </button>
          )}
        </>
      }
    >
      {empty ? (
        <p>{t("admin.teams.everyoneIn")}</p>
      ) : (
        <form id={formId} className="form" noValidate onSubmit={submit}>
          <div className="field">
            <label className="field__label" htmlFor={memberId}>
              {t("admin.teams.member")}
            </label>
            <PagedSelect
              id={memberId}
              value={chosen?.id ?? ""}
              onChange={setUserId}
              options={options}
              error={candidates.query.error}
              onRetry={() => void candidates.query.refetch()}
              hasMore={candidates.hasMore}
              onMore={candidates.loadMore}
              loadingMore={candidates.loadingMore}
            />
          </div>
          <div className="field">
            <label className="field__label" htmlFor={roleId}>
              {t("admin.teams.teamRole")}
            </label>
            <select
              id={roleId}
              className="select"
              value={role}
              onChange={(event) => {
                const next = TEAM_ROLES.find(
                  (candidate) => candidate === event.currentTarget.value,
                );
                if (next !== undefined) {
                  setRole(next);
                }
              }}
            >
              {TEAM_ROLES.map((candidate) => (
                <option key={candidate} value={candidate}>
                  {t(TEAM_ROLE_TEXT[candidate])}
                </option>
              ))}
            </select>
            <p className="field__hint">{t("admin.teams.teamRoleHint")}</p>
          </div>
          {add.error === null ? null : (
            <p className="admin-error" role="alert">
              {errorText(t, add.error, TEAM_ERRORS)}
            </p>
          )}
        </form>
      )}
    </Dialog>
  );
}
