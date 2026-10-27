import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import { Breadcrumbs, folderTrail } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useTeamContext } from "../../org/teamContext";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { AccessButton } from "./accessIntegration";
import {
  createDashboard,
  createFolder,
  DASHBOARDS_KEY,
  deleteFolder,
  FOLDERS_KEY,
  type Folder,
  fetchDashboards,
  foldersQuery,
  restoreFolder,
  updateFolder,
} from "./api";
import "./dashboards.css";
import { zoneOption } from "../../lib/timeSettings";
import { descendantIds, FolderTree, isRestricted } from "./FolderTree";
import { ImportDialog } from "./ImportDialog";
import { emptyModel } from "./model";
import { OwnerDialog, spaceTeams, TeamSpaceDialog } from "./TeamDialogs";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";

const listRoute = getRouteApi("/_app/dashboards");
const appRoute = getRouteApi("/_app");

/** Pause in typing after which the dashboard search runs. */
const SEARCH_DELAY_MS = 250;

export function DashboardsPage() {
  const { t } = useI18n();
  useDocumentTitle("dashboards.title");
  const org = useCurrentOrg();
  return (
    <Page title={t("dashboards.title")} lead={t("dashboards.lead")}>
      {org === undefined ? (
        <EmptyState icon="dashboards" title={t("dashboards.noOrg.title")}>
          {t("dashboards.noOrg.text")}
        </EmptyState>
      ) : (
        <DashboardBrowser orgId={org.id} />
      )}
    </Page>
  );
}

function DashboardBrowser({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const userId = appRoute.useRouteContext().me.id;
  const search = listRoute.useSearch();
  const navigate = listRoute.useNavigate();
  const router = useRouter();
  const listPath = listRoute.useMatch({ select: (match) => match.pathname });
  const searchId = useId();
  // The team context scopes the tree and the list; both wait for it, so they load once.
  const teams = useTeamContext();
  const folders = useQuery({ ...foldersQuery(orgId, teams.scope), enabled: teams.settled });
  const [creating, setCreating] = useState<"dashboard" | "folder" | "import" | "space" | null>(
    null,
  );
  const mayCreateSpace =
    spaceTeams(teams.context.teams, permissions.has("folders:permissions")).length > 0;
  // A link with `create` opens its dialog once; the parameter is dropped right away.
  useEffect(() => {
    if (search.create !== undefined) {
      setCreating(search.create);
      void navigate({ search: (prev) => ({ ...prev, create: undefined }), replace: true });
    }
  }, [search.create, navigate]);
  const queryClient = useQueryClient();
  const restore = useMutation({
    mutationFn: (id: string) => restoreFolder(orgId, id),
    onSuccess: async () => {
      // Restoring a folder brings its dashboards back too.
      await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
    },
  });
  // The search field updates at once; the list follows after a pause in typing.
  const [query, setQuery] = useState(search.q ?? "");
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // A dashboard opened within the pause leaves the list while it still shows (its page is
      // loading); the search must not take the person back to the list then.
      if (query !== (search.q ?? "") && router.latestLocation.pathname === listPath) {
        void navigate({
          search: (prev) => ({ ...prev, q: query === "" ? undefined : query }),
          replace: true,
        });
      }
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, search.q, navigate, router, listPath]);
  const folder = folders.data?.find((f) => f.id === search.folder);
  // Creating a dashboard in the selected folder follows that folder's `access.write` (a grant on
  // it counts); at the top level, and for folders and the trash, the organization role decides.
  const canWrite = folder?.access?.write === true || permissions.has("dashboards:write");

  const select = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, folder: id }), replace: true });

  return (
    <div className="browser">
      <aside className="browser__side">
        {folders.isError ? (
          <FormAlert>{errorMessage(t, folders.error)}</FormAlert>
        ) : (
          <FolderTree
            folders={folders.data ?? []}
            selected={search.folder}
            onSelect={select}
            storageKey={`kalzit.folderTree.${userId}`}
            activeTeam={teams.scope}
          />
        )}
        {mayCreateSpace ? (
          <button
            type="button"
            className="button button--secondary button--small browser__new-folder"
            onClick={() => setCreating("space")}
          >
            <Icon name="members" />
            {t("dashboards.team.newSpace")}
          </button>
        ) : null}
        {permissions.has("folders:write") ? (
          <button
            type="button"
            className="button button--secondary button--small browser__new-folder"
            onClick={() => setCreating("folder")}
          >
            <Icon name="plus" />
            {t("dashboards.folders.new")}
          </button>
        ) : null}
        <div className="browser__links">
          {permissions.has("dashboards:delete") ? (
            <Link to="/dashboards/trash" className="browser__link">
              {t("dashboards.trash.link")}
            </Link>
          ) : null}
          <Link to="/dashboards/playlists" className="browser__link">
            {t("playlists.title")}
          </Link>
          <Link to="/dashboards/library" className="browser__link">
            {t("libraryPanels.title")}
          </Link>
        </div>
      </aside>
      <section className="browser__main" aria-labelledby={`${searchId}-title`}>
        {folder === undefined ? null : (
          <Breadcrumbs
            crumbs={[
              {
                label: t("dashboards.folders.all"),
                link: { to: "/dashboards", search: {} },
              },
              ...folderTrail(folders.data ?? [], folder.id).map((step) => ({
                label: step.name,
                link: { to: "/dashboards" as const, search: { folder: step.id } },
              })),
            ]}
          />
        )}
        <div className="browser__header">
          <h2 className="section-title" id={`${searchId}-title`}>
            {folder?.name ?? t("dashboards.folders.all")}
            {folder?.ownerTeam ? (
              <span className="browser__restricted">
                <Icon name="members" />
                {t(folder.teamSpace ? "dashboards.team.spaceOf" : "dashboards.team.ownedBy", {
                  team: folder.ownerTeam.name,
                })}
              </span>
            ) : null}
            {isRestricted(folders.data ?? [], search.folder) && !folder?.teamSpace ? (
              <span className="browser__restricted">
                <Icon name="lock" />
                {t("dashboards.folders.restricted")}
              </span>
            ) : null}
          </h2>
          {canWrite ? (
            <div className="dashboard__tools">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setCreating("import")}
              >
                {t("dashboardTools.import.button")}
              </button>
              <button
                type="button"
                className="button button--primary"
                onClick={() => setCreating("dashboard")}
              >
                {t("dashboards.new")}
              </button>
            </div>
          ) : null}
        </div>
        <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
        {folder === undefined ? null : (
          <FolderActions
            orgId={orgId}
            folder={folder}
            folders={folders.data ?? []}
            onDeleted={(deleted) => {
              showToast({
                message: t("dashboards.folders.deleted", { name: deleted.name }),
                undo: () => restore.mutate(deleted.id),
              });
              void select(undefined);
            }}
          />
        )}
        <div className="field browser__search">
          <label className="visually-hidden" htmlFor={searchId}>
            {t("dashboards.search")}
          </label>
          <input
            id={searchId}
            type="search"
            className="input"
            placeholder={t("dashboards.search")}
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        <DashboardList
          orgId={orgId}
          folderId={search.folder}
          q={search.q}
          folders={folders.data ?? []}
          team={teams.scope}
          enabled={teams.settled}
          onClearSearch={() => {
            setQuery("");
            void navigate({ search: (prev) => ({ ...prev, q: undefined }), replace: true });
          }}
          onCreate={canWrite ? () => setCreating("dashboard") : undefined}
        />
      </section>
      {creating === "dashboard" ? (
        <NewDashboardDialog
          orgId={orgId}
          folders={folders.data ?? []}
          folderId={search.folder ?? teams.context.defaultFolderId ?? undefined}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {creating === "space" ? (
        <TeamSpaceDialog orgId={orgId} onClose={() => setCreating(null)} onCreated={select} />
      ) : null}
      {creating === "import" ? (
        <ImportDialog
          orgId={orgId}
          folderId={search.folder ?? null}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {creating === "folder" ? (
        <FolderDialog
          orgId={orgId}
          folders={folders.data ?? []}
          parentId={search.folder ?? null}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}

function DashboardList({
  orgId,
  folderId,
  q,
  folders,
  team,
  enabled,
  onClearSearch,
  onCreate,
}: {
  orgId: string;
  folderId: string | undefined;
  q: string | undefined;
  folders: readonly Folder[];
  /** The active team: the list leaves out other teams' spaces. */
  team: string | undefined;
  enabled: boolean;
  /** Empties the search field and shows the folder again (a search that found nothing). */
  onClearSearch: () => void;
  /** Opens "New dashboard" here; absent without the right to create one. */
  onCreate: (() => void) | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const list = useInfiniteQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "list", folderId ?? null, q ?? "", team ?? null],
    queryFn: ({ pageParam, signal }) =>
      fetchDashboards(orgId, { folderId, q, team, cursor: pageParam }, signal),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A new search keeps showing the previous results until its own arrive, without "Loading".
    placeholderData: keepPreviousData,
  });
  const dateFormat = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  const items = list.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    return (
      <EmptyState
        icon="dashboards"
        title={q === undefined ? t("dashboards.empty.title") : t("dashboards.empty.search")}
        actions={
          q !== undefined ? (
            <button type="button" className="button button--secondary" onClick={onClearSearch}>
              {t("dashboards.empty.clearSearch")}
            </button>
          ) : onCreate !== undefined ? (
            <button type="button" className="button button--secondary" onClick={onCreate}>
              <Icon name="plus" />
              {t("dashboards.empty.create")}
            </button>
          ) : undefined
        }
      >
        {q === undefined ? t("dashboards.empty.text") : t("dashboards.empty.searchText")}
      </EmptyState>
    );
  }
  const folderName = (id: string | null) => folders.find((f) => f.id === id)?.name ?? "";
  return (
    <>
      <table className="data-table data-table--stack" {...STACK_ROLES.table}>
        <thead {...STACK_ROLES.rowgroup}>
          <tr {...STACK_ROLES.row}>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("dashboards.column.title")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("dashboards.column.folder")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("dashboards.column.updated")}
            </th>
          </tr>
        </thead>
        <tbody {...STACK_ROLES.rowgroup}>
          {items.map((item) => (
            <tr key={item.id} {...STACK_ROLES.row}>
              <td {...STACK_ROLES.cell}>
                <Link to="/dashboards/$dashboardId" params={{ dashboardId: item.id }} search={{}}>
                  {item.title === "" ? t("dashboards.untitled") : item.title}
                </Link>
                {item.ownerTeam === null ? null : (
                  <span className="dashboard-list__team">
                    <Icon name="members" />
                    {t(item.teamOnly ? "dashboards.team.onlyTeam" : "dashboards.team.ownedBy", {
                      team: item.ownerTeam.name,
                    })}
                  </span>
                )}
              </td>
              {/* Optional: a dashboard outside any folder leaves no empty line on a phone. */}
              <td
                {...STACK_ROLES.cell}
                className="data-table__muted data-table__optional"
                data-label={t("dashboards.column.folder")}
              >
                {folderName(item.folderId)}
              </td>
              <td
                {...STACK_ROLES.cell}
                className="data-table__muted"
                data-label={t("dashboards.column.updated")}
              >
                {item.updatedAt > 0 ? dateFormat.format(item.updatedAt) : ""}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {list.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {t("dashboards.loadMore")}
        </button>
      ) : null}
    </>
  );
}

function FolderSelect({
  folders,
  value,
  onChange,
  exclude,
  label,
}: {
  folders: readonly Folder[];
  value: string | null;
  onChange: (id: string | null) => void;
  exclude?: Set<string>;
  label: string;
}) {
  const { t } = useI18n();
  const id = useId();
  return (
    <div className="field">
      <label className="field__label" htmlFor={id}>
        {label}
      </label>
      <select
        id={id}
        className="select"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.currentTarget.value === "" ? null : event.currentTarget.value)
        }
      >
        <option value="">{t("dashboards.folders.none")}</option>
        {folders
          .filter((f) => exclude?.has(f.id) !== true)
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
      </select>
    </div>
  );
}

function NewDashboardDialog({
  orgId,
  folders,
  folderId,
  onClose,
}: {
  orgId: string;
  folders: readonly Folder[];
  folderId: string | undefined;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [folder, setFolder] = useState<string | null>(folderId ?? null);
  const [error, setError] = useState<string | undefined>(undefined);
  const create = useMutation({
    mutationFn: () =>
      createDashboard(orgId, {
        folderId: folder,
        model: emptyModel(title.trim()),
        defaultTimeRange: true,
      }),
    onSuccess: async ({ id }) => {
      await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
      onClose();
      await navigate({
        to: "/dashboards/$dashboardId",
        params: { dashboardId: id },
        search: { edit: true },
      });
    },
  });
  const formId = useId();
  return (
    <Dialog
      title={t("dashboards.new.title")}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={create.isPending}
          >
            {t("dashboards.new.create")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (title.trim() === "") {
            setError(t("dashboards.new.titleRequired"));
            return;
          }
          create.mutate();
        }}
      >
        <FormAlert>{create.isError ? errorMessage(t, create.error) : null}</FormAlert>
        <TextField
          label={t("dashboards.new.titleLabel")}
          value={title}
          onValueChange={(value) => {
            setTitle(value);
            setError(undefined);
          }}
          error={error}
          data-autofocus
          autoComplete="off"
        />
        <FolderSelect
          folders={folders}
          value={folder}
          onChange={setFolder}
          label={t("dashboards.column.folder")}
        />
      </form>
    </Dialog>
  );
}

/** Create a folder, or rename and move an existing one. */
function FolderDialog({
  orgId,
  folders,
  parentId,
  folder,
  onClose,
}: {
  orgId: string;
  folders: readonly Folder[];
  parentId: string | null;
  folder?: Folder;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [name, setName] = useState(folder?.name ?? "");
  const [parent, setParent] = useState<string | null>(folder?.parentId ?? parentId);
  const [error, setError] = useState<string | undefined>(undefined);
  const formId = useId();
  const save = useMutation({
    mutationFn: () =>
      folder === undefined
        ? createFolder(orgId, { name: name.trim(), parentId: parent })
        : updateFolder(orgId, folder.id, {
            name: name.trim(),
            parentId: parent,
            version: folder.version,
          }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
      onClose();
    },
  });
  return (
    <Dialog
      title={
        folder === undefined ? t("dashboards.folders.newTitle") : t("dashboards.folders.editTitle")
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          <button
            type="submit"
            form={formId}
            className="button button--primary"
            disabled={save.isPending}
          >
            {t("dashboards.folders.save")}
          </button>
        </>
      }
    >
      <form
        id={formId}
        className="form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (name.trim() === "") {
            setError(t("dashboards.folders.nameRequired"));
            return;
          }
          save.mutate();
        }}
      >
        <FormAlert>{save.isError ? errorMessage(t, save.error) : null}</FormAlert>
        <TextField
          label={t("dashboards.folders.name")}
          value={name}
          onValueChange={(value) => {
            setName(value);
            setError(undefined);
          }}
          error={error}
          data-autofocus
          autoComplete="off"
        />
        <FolderSelect
          folders={folders}
          value={parent}
          onChange={setParent}
          label={t("dashboards.folders.parent")}
          {...(folder === undefined ? {} : { exclude: descendantIds(folders, folder.id) })}
        />
      </form>
    </Dialog>
  );
}

function FolderActions({
  orgId,
  folder,
  folders,
  onDeleted,
}: {
  orgId: string;
  folder: Folder;
  folders: readonly Folder[];
  onDeleted: (folder: Folder) => void;
}) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const [dialog, setDialog] = useState<"edit" | "delete" | "owner" | null>(null);
  // Deleting or restoring a folder moves its dashboards too, so both lists are read again.
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: [FOLDERS_KEY, orgId] });
    await queryClient.invalidateQueries({ queryKey: [DASHBOARDS_KEY, orgId] });
  };
  const restrict = useMutation({
    mutationFn: (restricted: boolean) =>
      updateFolder(orgId, folder.id, { restricted, version: folder.version }),
    onSuccess: refresh,
  });
  const remove = useMutation({
    mutationFn: () => deleteFolder(orgId, folder.id),
    onSuccess: async () => {
      setDialog(null);
      await refresh();
      onDeleted(folder);
    },
  });

  return (
    <div className="folder-actions">
      <FormAlert>{restrict.isError ? errorMessage(t, restrict.error) : null}</FormAlert>
      {(folder.access?.write ?? permissions.has("folders:write")) ? (
        <div className="toolbar">
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setDialog("edit")}
          >
            {t("dashboards.folders.edit")}
          </button>
          {(folder.access?.permissions ?? permissions.has("folders:permissions")) ? (
            <label className="checkbox">
              <input
                type="checkbox"
                checked={folder.restricted}
                disabled={restrict.isPending}
                onChange={(event) => restrict.mutate(event.currentTarget.checked)}
              />
              {t("dashboards.folders.restrict")}
            </label>
          ) : null}
          <AccessButton
            resource={{ kind: "folder", id: folder.id, name: folder.name }}
            allowed={folder.access?.permissions}
          />
          {folder.access?.permissions === true && folder.access.write ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setDialog("owner")}
            >
              {t("dashboards.team.ownerButton")}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            onClick={() => setDialog("delete")}
          >
            {t("dashboards.folders.delete")}
          </button>
        </div>
      ) : null}
      {dialog === "edit" ? (
        <FolderDialog
          orgId={orgId}
          folders={folders}
          parentId={folder.parentId}
          folder={folder}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "owner" ? (
        <OwnerDialog
          orgId={orgId}
          kind="folders"
          id={folder.id}
          name={folder.name}
          owner={folder.ownerTeam}
          visibility={folder.restricted ? "team" : "shared"}
          version={folder.version}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === "delete" ? (
        <ConfirmDialog
          title={t("dashboards.folders.deleteTitle")}
          confirmLabel={t("dashboards.folders.deleteConfirm")}
          onCancel={() => setDialog(null)}
          onConfirm={() => remove.mutate()}
          busy={remove.isPending}
          error={remove.isError ? errorMessage(t, remove.error) : undefined}
        >
          {t("dashboards.folders.deleteText", { name: folder.name })}
        </ConfirmDialog>
      ) : null}
    </div>
  );
}
