import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useState } from "react";
import type { Permission } from "../../../api/generated/shapes";
import { useI18n } from "../../../i18n/i18n";
import { useCurrentOrg, useOrgPermissions } from "../../../org/useOrg";
import {
  addGrant,
  adminKeys,
  type Grant,
  type GrantInput,
  type GrantLevel,
  levelsFor,
  listGrants,
  listMembers,
  listTeams,
  MAX_PAGE_SIZE,
  type ResourceType,
  removeGrant,
  SUBJECT_TYPES,
  type SubjectType,
} from "../api";
import { LEVEL_TEXT, roleLabel, SUBJECT_TEXT } from "../catalog";
import { Dialog } from "../components/Dialog";
import { Notice, useNotice } from "../components/Notice";
import { useRowKeys } from "../components/rows";
import { LoadState } from "../components/Section";
import { errorText, GRANT_ERRORS } from "../errors";
import { useRoles } from "../org/shared";
import { WhyCanI } from "./WhyCanI";

/** A folder, dashboard or data source whose access the dialog shows. */
export interface AccessResource {
  type: ResourceType;
  id: string;
  /** Shown in the title, such as the dashboard's title. */
  name: string;
}

export interface AccessDialogProps {
  open: boolean;
  onClose: () => void;
  resource: AccessResource;
  /** The organization the resource belongs to; the current one if absent. */
  orgId?: string | undefined;
}

/** The permission that lets someone change who may access a resource of this type. */
export const MANAGE_PERMISSION: Record<ResourceType, Permission> = {
  folder: "folders:permissions",
  dashboard: "dashboards:share",
  datasource: "datasources:permissions",
};

/** What the subject pickers need: whose names the user may read. */
const READ_PERMISSION: Record<SubjectType, Permission> = {
  user: "users:read",
  team: "teams:read",
  role: "roles:read",
};

/**
 * Who has access to one resource beyond their role: users, teams and roles with a level (view,
 * edit, manage; query instead of view for data sources). Members without the manage permission
 * see the list read-only. Changes apply at once; removing a grant can be undone.
 */
export function AccessDialog({ open, onClose, resource, orgId }: AccessDialogProps) {
  const { t } = useI18n();
  const current = useCurrentOrg();
  const org = orgId ?? current?.id ?? "";
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const canManage = permissions.has(MANAGE_PERMISSION[resource.type]);
  const queryKey = adminKeys.grants(org, resource.type, resource.id);
  const grants = useQuery({
    queryKey,
    queryFn: () => listGrants(org, resource.type, resource.id),
    enabled: open && org !== "",
  });
  const notice = useNotice();
  const list = grants.data ?? [];
  const keys = useRowKeys(list.length);

  const refresh = () => queryClient.invalidateQueries({ queryKey });

  const add = useMutation({
    mutationFn: (input: GrantInput) => addGrant(org, input),
    onSuccess: async () => {
      await refresh();
    },
  });

  const remove = useMutation({
    mutationFn: (grant: Grant) => removeGrant(org, grant.id),
    onSuccess: async (_, grant) => {
      await refresh();
      notice.show({
        message: t("admin.access.removed", { name: grant.subjectName }),
        undo: () =>
          add.mutate(
            {
              subjectType: grant.subjectType,
              subjectId: grant.subjectId,
              resourceType: grant.resourceType,
              resourceId: grant.resourceId,
              level: grant.level,
            },
            {
              onSuccess: () =>
                notice.show({ message: t("admin.access.restored", { name: grant.subjectName }) }),
              onError: (error) => notice.showError(errorText(t, error, GRANT_ERRORS)),
            },
          ),
      });
    },
    onError: (error) => notice.showError(errorText(t, error, GRANT_ERRORS)),
  });

  return (
    <Dialog
      open={open}
      wide
      title={t("admin.access.title", { name: resource.name })}
      onClose={onClose}
      footer={
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("admin.common.close")}
        </button>
      }
    >
      <p className="admin-dialog__text">
        {t(`admin.access.lead.${resource.type}`)} {canManage ? null : t("admin.access.readOnly")}
      </p>
      <Notice notice={notice.notice} onDismiss={notice.clear} />
      {grants.data === undefined ? (
        <LoadState error={grants.error} onRetry={() => void grants.refetch()} />
      ) : list.length === 0 ? (
        <p className="admin-empty">{t("admin.access.none")}</p>
      ) : (
        <ul className="admin-list" aria-label={t("admin.access.listLabel")} {...keys.listProps}>
          {list.map((grant, index) => (
            <li key={grant.id} className="admin-row" {...keys.rowProps(index)}>
              <div className="admin-row__main">
                <span className="admin-row__title">{grant.subjectName}</span>
                <span className="admin-row__meta">{t(SUBJECT_TEXT[grant.subjectType])}</span>
              </div>
              <span className="admin-badge">{t(LEVEL_TEXT[grant.level])}</span>
              {canManage ? (
                <div className="admin-row__actions">
                  <button
                    type="button"
                    className="button button--secondary"
                    aria-label={t("admin.access.removeNamed", { name: grant.subjectName })}
                    disabled={remove.isPending}
                    onClick={() => remove.mutate(grant)}
                  >
                    {t("admin.common.remove")}
                  </button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <div className="admin-access__why">
        <span>{t("admin.access.whyManage")}</span>
        <WhyCanI
          permission={MANAGE_PERMISSION[resource.type]}
          resource={{ type: resource.type, id: resource.id }}
          orgId={org}
        />
      </div>
      {canManage && open ? (
        <AddGrantForm
          orgId={org}
          resource={resource}
          busy={add.isPending}
          error={add.error === null ? null : errorText(t, add.error, GRANT_ERRORS)}
          onAdd={(input, name) =>
            add.mutate(input, {
              onSuccess: () => notice.show({ message: t("admin.access.added", { name }) }),
            })
          }
        />
      ) : null}
    </Dialog>
  );
}

function AddGrantForm({
  orgId,
  resource,
  busy,
  error,
  onAdd,
}: {
  orgId: string;
  resource: AccessResource;
  busy: boolean;
  error: string | null;
  onAdd: (input: GrantInput, name: string) => void;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const ids = { type: useId(), subject: useId(), level: useId() };
  const types = SUBJECT_TYPES.filter((type) => permissions.has(READ_PERMISSION[type]));
  const [type, setType] = useState<SubjectType | undefined>(undefined);
  const subjectType = type ?? types[0];
  const levels = levelsFor(resource.type);
  const [level, setLevel] = useState<GrantLevel>(levels[0] ?? "view");
  const [subject, setSubject] = useState("");

  const members = useQuery({
    queryKey: [...adminKeys.members(orgId), "picker"],
    queryFn: () => listMembers(orgId, undefined, MAX_PAGE_SIZE),
    enabled: subjectType === "user",
  });
  const teams = useQuery({
    queryKey: [...adminKeys.teams(orgId), "picker"],
    queryFn: () => listTeams(orgId, undefined, MAX_PAGE_SIZE),
    enabled: subjectType === "team",
  });
  const roles = useRoles(orgId, subjectType === "role");

  if (subjectType === undefined) {
    return <p className="admin-section__lead">{t("admin.access.cannotPick")}</p>;
  }

  let options: { id: string; label: string }[] | undefined;
  let loadError: unknown = null;
  let retry: () => void = () => undefined;
  if (subjectType === "user") {
    options = members.data?.items.map((member) => ({
      id: member.userId,
      label: t("admin.common.nameAndEmail", { name: member.name, email: member.email }),
    }));
    loadError = members.error;
    retry = () => void members.refetch();
  } else if (subjectType === "team") {
    options = teams.data?.items.map((team) => ({ id: team.id, label: team.name }));
    loadError = teams.error;
    retry = () => void teams.refetch();
  } else {
    options = roles.data?.map((role) => ({
      id: role.id,
      label: roleLabel(t, role.id, roles.data),
    }));
    loadError = roles.error;
    retry = () => void roles.refetch();
  }
  const chosen = options?.find((option) => option.id === subject) ?? options?.[0];

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || chosen === undefined || subjectType === undefined) {
      return;
    }
    onAdd(
      {
        subjectType,
        subjectId: chosen.id,
        resourceType: resource.type,
        resourceId: resource.id,
        level,
      },
      chosen.label,
    );
  }

  return (
    <form className="admin-access__add" noValidate onSubmit={submit}>
      <h3>{t("admin.access.addTitle")}</h3>
      <div className="admin-filters">
        <div className="field">
          <label className="field__label" htmlFor={ids.type}>
            {t("admin.access.subjectType")}
          </label>
          <select
            id={ids.type}
            className="select"
            value={subjectType}
            onChange={(event) => {
              setType(SUBJECT_TYPES.find((candidate) => candidate === event.currentTarget.value));
              setSubject("");
            }}
          >
            {types.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(SUBJECT_TEXT[candidate])}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.subject}>
            {t(SUBJECT_TEXT[subjectType])}
          </label>
          {options === undefined ? (
            <LoadState error={loadError} onRetry={retry} />
          ) : (
            <select
              id={ids.subject}
              className="select"
              value={chosen?.id ?? ""}
              onChange={(event) => setSubject(event.currentTarget.value)}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          )}
        </div>
        <div className="field">
          <label className="field__label" htmlFor={ids.level}>
            {t("admin.access.level")}
          </label>
          <select
            id={ids.level}
            className="select"
            value={level}
            onChange={(event) => {
              const next = levels.find((candidate) => candidate === event.currentTarget.value);
              if (next !== undefined) {
                setLevel(next);
              }
            }}
          >
            {levels.map((candidate) => (
              <option key={candidate} value={candidate}>
                {t(LEVEL_TEXT[candidate])}
              </option>
            ))}
          </select>
        </div>
      </div>
      {error === null ? null : (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}
      <div className="form__actions">
        <button
          type="submit"
          className="button button--primary"
          aria-disabled={busy || chosen === undefined}
        >
          {t("admin.access.add")}
        </button>
      </div>
    </form>
  );
}
