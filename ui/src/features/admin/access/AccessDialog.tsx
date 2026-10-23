import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { isApiError } from "../../../api/client";
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
import { usePagedList } from "../components/lists";
import { Notice, useNotice } from "../components/Notice";
import { PagedSelect, type PickerOption } from "../components/PagedSelect";
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

/**
 * The permission that manages access to a resource of this type. A member may hold it through
 * their role or through an `admin` grant on the resource (or a folder above it), so the org-wide
 * permissions alone do not tell whether someone may open the dialog's list: the server does.
 */
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
 * edit, manage; query instead of view for data sources). Listing the grants needs the manage
 * permission on the resource, so a successful list is what unlocks changing them; without it the
 * dialog says the user cannot see who has access. Changes apply at once; removing a grant can be
 * undone.
 */
export function AccessDialog({ open, onClose, resource, orgId }: AccessDialogProps) {
  const { t } = useI18n();
  const current = useCurrentOrg();
  const org = orgId ?? current?.id ?? "";
  const queryClient = useQueryClient();
  const queryKey = adminKeys.grants(org, resource.type, resource.id);
  const grants = usePagedList(
    queryKey,
    (cursor) => listGrants(org, resource.type, resource.id, cursor),
    open && org !== "",
  );
  const notice = useNotice({ inline: true });
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const list = grants.items ?? [];
  const keys = useRowKeys(list.length);
  const refused = isApiError(grants.query.error, "forbidden");
  const canManage = grants.items !== undefined;

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
      // The removed row and its button are gone; keep focus in the dialog, on the list.
      listTitleRef.current?.focus();
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

  let body = null;
  if (refused) {
    body = <p className="admin-empty">{t("admin.access.cannotSee")}</p>;
  } else if (grants.items === undefined) {
    body = <LoadState error={grants.query.error} onRetry={() => void grants.query.refetch()} />;
  } else if (list.length === 0) {
    body = <p className="admin-empty">{t("admin.access.none")}</p>;
  } else {
    body = (
      <ul className="admin-list" aria-label={t("admin.access.listLabel")} {...keys.listProps}>
        {list.map((grant, index) => (
          <li key={grant.id} className="admin-row" {...keys.rowProps(index)}>
            <div className="admin-row__main">
              <span className="admin-row__title">
                {grant.subjectType === "role"
                  ? roleLabel(t, grant.subjectName, undefined)
                  : grant.subjectName}
              </span>
              <span className="admin-row__meta">{t(SUBJECT_TEXT[grant.subjectType])}</span>
            </div>
            <span className="admin-badge">{t(LEVEL_TEXT[grant.level])}</span>
            <div className="admin-row__actions">
              <button
                type="button"
                className="button button--secondary"
                aria-label={t("admin.access.removeNamed", { name: grant.subjectName })}
                aria-disabled={remove.isPending}
                onClick={() => {
                  if (!remove.isPending) {
                    remove.mutate(grant);
                  }
                }}
              >
                {t("admin.common.remove")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    );
  }

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
      <p className="admin-dialog__text">{t(`admin.access.lead.${resource.type}`)}</p>
      <Notice inline notice={notice.notice} onDismiss={notice.clear} />
      <h3 className="admin-access__title" ref={listTitleRef} tabIndex={-1}>
        {t("admin.access.listLabel")}
      </h3>
      {body}
      {grants.hasMore ? (
        <button type="button" className="button button--secondary" onClick={grants.loadMore}>
          {t("admin.common.showMore")}
        </button>
      ) : null}
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

  const members = usePagedList(
    [...adminKeys.members(orgId), "picker"],
    (cursor) => listMembers(orgId, cursor, MAX_PAGE_SIZE),
    subjectType === "user",
  );
  const teams = usePagedList(
    [...adminKeys.teams(orgId), "picker"],
    (cursor) => listTeams(orgId, cursor, MAX_PAGE_SIZE),
    subjectType === "team",
  );
  const roles = useRoles(orgId, subjectType === "role");

  if (subjectType === undefined) {
    return <p className="admin-section__lead">{t("admin.access.cannotPick")}</p>;
  }

  let options: PickerOption[] | undefined;
  let paged:
    | {
        hasMore: boolean;
        loadMore: () => void;
        loadingMore: boolean;
        query: { error: unknown; refetch: () => unknown };
      }
    | undefined;
  let loadError: unknown = null;
  let retry: () => void = () => undefined;
  if (subjectType === "user") {
    options = members.items?.map((member) => ({
      id: member.userId,
      label: t("admin.common.nameAndEmail", { name: member.name, email: member.email }),
    }));
    paged = members;
  } else if (subjectType === "team") {
    options = teams.items?.map((team) => ({ id: team.id, label: team.name }));
    paged = teams;
  } else {
    options = roles.data?.map((role) => ({
      id: role.id,
      label: roleLabel(t, role.id, roles.data),
    }));
    loadError = roles.error;
    retry = () => void roles.refetch();
  }
  if (paged !== undefined) {
    loadError = paged.query.error;
    const query = paged.query;
    retry = () => void query.refetch();
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
          <PagedSelect
            id={ids.subject}
            value={chosen?.id ?? ""}
            onChange={setSubject}
            options={options}
            error={loadError}
            onRetry={retry}
            hasMore={paged?.hasMore ?? false}
            onMore={paged?.loadMore ?? (() => undefined)}
            loadingMore={paged?.loadingMore ?? false}
          />
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
