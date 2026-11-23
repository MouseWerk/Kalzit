import {
  type InfiniteData,
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { useEffect, useId, useState } from "react";
import type { Page as ResultPage } from "../../api/generated/shapes";
import { Breadcrumbs, folderTrail } from "../../components/Breadcrumbs";
import { CutText } from "../../components/CutText";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon, type IconName } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { TextField } from "../../components/TextField";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { stillOnRoute } from "../../lib/stillOnRoute";
import { readPreference, writePreference } from "../../lib/storage";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useTeamContext } from "../../org/teamContext";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { HOME_KEY, recentsQuery, setStarred } from "../../shell/homeApi";
import { relativeTime } from "../../shell/startData";
import { AccessButton } from "./accessIntegration";
import {
  createDashboard,
  createFolder,
  DASHBOARDS_KEY,
  type DashboardCounts,
  type DashboardSort,
  type DashboardSummary,
  deleteFolder,
  FOLDERS_KEY,
  type Folder,
  fetchDashboardCounts,
  fetchDashboards,
  foldersQuery,
  restoreFolder,
  updateFolder,
} from "./api";
import "./dashboards.css";
import { Select } from "../../components/Select";
import { zoneOption } from "../../lib/timeSettings";
import { DashboardSketch } from "./DashboardSketch";
import { descendantIds, FolderTree, isRestricted } from "./FolderTree";
import { ImportDialog } from "./ImportDialog";
import { emptyModel } from "./model";
import type { DashboardsSearch } from "./routes";
import { OwnerDialog, spaceTeams, TeamSpaceDialog } from "./TeamDialogs";
import { ConfirmDialog, Dialog } from "./ui/Dialog";
import { errorMessage } from "./ui/errors";

const listRoute = getRouteApi("/_app/dashboards");
const appRoute = getRouteApi("/_app");

/** Pause in typing after which the dashboard search runs. */
const SEARCH_DELAY_MS = 250;

/** At most this many recently opened dashboards above the list. */
const RECENT_LINKS = 4;

/** At most this many tags in the tag filter, the most used ones (and the chosen one). */
const TAG_CHOICES = 30;

/** How the list shows dashboards, remembered per person in this browser. */
type Display = "list" | "tiles";

const displayKey = (userId: string) => `kalzit.dashboardsDisplay.${userId}`;

function readDisplay(userId: string): Display {
  return readPreference(displayKey(userId)) === "tiles" ? "tiles" : "list";
}

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

/** The order the list takes when the address names none. */
function defaultSort(view: DashboardsSearch["view"]): DashboardSort {
  return view === "recent" ? "opened" : "updated";
}

function DashboardBrowser({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const userId = appRoute.useRouteContext().me.id;
  const search = listRoute.useSearch();
  const navigate = listRoute.useNavigate();
  const router = useRouter();
  const searchId = useId();
  // The team context scopes the tree and the list; both wait for it, so they load once.
  const teams = useTeamContext();
  const folders = useQuery({ ...foldersQuery(orgId, teams.scope), enabled: teams.settled });
  // The numbers beside the tree's entries and the tags of the tag filter, without the list's
  // filters.
  const counts = useQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "counts", teams.scope ?? null],
    queryFn: ({ signal }) => fetchDashboardCounts(orgId, teams.scope, signal),
    enabled: teams.settled,
  });
  const [creating, setCreating] = useState<"dashboard" | "folder" | "import" | "space" | null>(
    null,
  );
  const [display, setDisplay] = useState<Display>(() => readDisplay(userId));
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
      if (query !== (search.q ?? "") && stillOnRoute(router, listRoute.id)) {
        void navigate({
          search: (prev) => ({ ...prev, q: query === "" ? undefined : query }),
          replace: true,
        });
      }
    }, SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [query, search.q, navigate, router]);
  const allFolders = folders.data ?? [];
  // A view (favorites, recently opened) stands instead of a folder.
  const view = search.view;
  const folder = view === undefined ? allFolders.find((f) => f.id === search.folder) : undefined;
  const folderId = view === undefined ? search.folder : undefined;
  const sort = search.sort ?? defaultSort(view);
  // Creating a dashboard in the selected folder follows that folder's `access.write` (a grant on
  // it counts); at the top level, and for folders and the trash, the organization role decides.
  const canWrite = folder?.access?.write === true || permissions.has("dashboards:write");

  const select = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, folder: id, view: undefined }), replace: true });
  const chooseDisplay = (next: Display) => {
    setDisplay(next);
    writePreference(displayKey(userId), next);
  };
  const clearFilters = () => {
    setQuery("");
    void navigate({
      search: (prev) => ({ ...prev, q: undefined, tag: undefined }),
      replace: true,
    });
  };

  const viewLabel = (name: "starred" | "recent") =>
    name === "starred" ? t("dashboards.views.starred") : t("dashboards.views.recent");
  const sortLabel = (name: DashboardSort) =>
    name === "title"
      ? t("dashboards.sort.title")
      : name === "opened"
        ? t("dashboards.sort.opened")
        : t("dashboards.sort.updated");
  const sortText = t("dashboards.sort.button", { order: sortLabel(sort) });
  const sortEntries: ToolbarMenuEntry[] = (["updated", "title", "opened"] as const).map((name) => ({
    kind: "radio",
    key: name,
    label: sortLabel(name),
    checked: sort === name,
    onSelect: () =>
      void navigate({
        search: (prev) => ({ ...prev, sort: name === defaultSort(view) ? undefined : name }),
        replace: true,
      }),
  }));
  const tags = (counts.data?.tags ?? []).slice(0, TAG_CHOICES).map((entry) => entry.tag);
  const chosenTag = search.tag;
  if (chosenTag !== undefined && !tags.some((tag) => sameTag(tag, chosenTag))) {
    tags.unshift(chosenTag);
  }
  const tagText =
    search.tag === undefined
      ? t("dashboards.tags.button")
      : t("dashboards.tags.active", { tag: search.tag });
  const tagEntries: ToolbarMenuEntry[] = [
    {
      kind: "radio",
      key: "all",
      label: t("dashboards.tags.all"),
      checked: search.tag === undefined,
      onSelect: () =>
        void navigate({ search: (prev) => ({ ...prev, tag: undefined }), replace: true }),
    },
    ...(tags.length === 0
      ? [{ kind: "heading" as const, key: "none", label: t("dashboards.tags.none") }]
      : [{ kind: "separator" as const, key: "sep" }]),
    ...tags.map(
      (tag): ToolbarMenuEntry => ({
        kind: "radio",
        key: `tag-${tag}`,
        label: tag,
        checked: search.tag !== undefined && sameTag(tag, search.tag),
        onSelect: () => void navigate({ search: (prev) => ({ ...prev, tag }), replace: true }),
      }),
    ),
  ];
  const importEntries: ToolbarMenuEntry[] = [
    {
      key: "grafana",
      label: t("dashboardTools.import.grafana"),
      icon: "download",
      onSelect: () =>
        void router.navigate({ to: "/dashboards/import/grafana", search: { folder: folderId } }),
    },
    {
      key: "file",
      label: t("dashboardTools.import.button"),
      icon: "upload",
      onSelect: () => setCreating("import"),
    },
  ];
  // "All dashboards" alone shows what the caller opened last above the list.
  const showRecents =
    view === undefined &&
    folderId === undefined &&
    search.q === undefined &&
    search.tag === undefined;
  const where =
    view !== undefined ? viewLabel(view) : (folder?.name ?? t("dashboards.folders.all"));
  const sideEntry = (
    to: DashboardsSearch,
    current: boolean,
    icon: IconName,
    label: string,
    count: number | undefined,
  ) => (
    <Link
      to="/dashboards"
      search={to}
      className="dashboards-side__entry"
      aria-current={current ? "page" : undefined}
      data-current={current ? "true" : undefined}
    >
      <Icon name={icon} />
      <CutText className="truncate" text={label} />
      {count === undefined ? null : (
        <>
          {" "}
          <span className="folder-tree__count">{count}</span>
        </>
      )}
    </Link>
  );

  return (
    <div className="browser dashboards-browser">
      {canWrite ? (
        <PageActions>
          <ToolbarMenu
            appearance="button"
            label={t("dashboards.import.menu")}
            text={t("dashboards.import.menu")}
            icon="upload"
            entries={importEntries}
          />
          <button
            type="button"
            className="button button--primary"
            onClick={() => setCreating("dashboard")}
          >
            {t("dashboards.new")}
          </button>
        </PageActions>
      ) : null}
      <aside className="browser__side dashboards-side">
        <nav className="dashboards-side__group" aria-label={t("dashboards.views.label")}>
          {sideEntry(
            {},
            view === undefined && search.folder === undefined,
            "dashboards",
            t("dashboards.folders.all"),
            counts.data?.total,
          )}
          {sideEntry(
            { view: "starred" },
            view === "starred",
            "star",
            t("dashboards.views.starred"),
            counts.data?.starred,
          )}
          {sideEntry(
            { view: "recent" },
            view === "recent",
            "clock",
            t("dashboards.views.recent"),
            undefined,
          )}
        </nav>
        <hr className="dashboards-side__separator" />
        {folders.isError ? (
          <FormAlert>{errorMessage(t, folders.error)}</FormAlert>
        ) : (
          <FolderTree
            folders={allFolders}
            selected={folderId}
            onSelect={select}
            storageKey={`kalzit.folderTree.${userId}`}
            activeTeam={teams.scope}
            showAll={false}
            counts={
              counts.data === undefined
                ? undefined
                : { all: counts.data.total, folders: counts.data.folders }
            }
          />
        )}
        {mayCreateSpace ? (
          <button
            type="button"
            className="dashboards-side__entry dashboards-side__action"
            onClick={() => setCreating("space")}
          >
            <Icon name="members" />
            {t("dashboards.team.newSpace")}
          </button>
        ) : null}
        {permissions.has("folders:write") ? (
          <button
            type="button"
            className="dashboards-side__entry dashboards-side__action"
            onClick={() => setCreating("folder")}
          >
            <Icon name="plus" />
            {t("dashboards.folders.new")}
          </button>
        ) : null}
        <hr className="dashboards-side__separator" />
        <nav className="dashboards-side__group" aria-label={t("dashboards.more.label")}>
          <Link to="/dashboards/playlists" className="dashboards-side__entry">
            <Icon name="screen" />
            {t("playlists.title")}
          </Link>
          <Link to="/dashboards/library" className="dashboards-side__entry">
            <Icon name="library" />
            {t("libraryPanels.title")}
          </Link>
          {permissions.has("dashboards:delete") ? (
            <Link to="/dashboards/trash" className="dashboards-side__entry">
              <Icon name="trash" />
              {t("dashboards.trash.link")}
            </Link>
          ) : null}
        </nav>
      </aside>
      <section className="browser__main" aria-labelledby={`${searchId}-title`}>
        {folder === undefined ? (
          <Breadcrumbs crumbs={[{ label: t("dashboards.title") }]} />
        ) : (
          <Breadcrumbs
            crumbs={[
              {
                label: t("dashboards.folders.all"),
                link: { to: "/dashboards", search: {} },
              },
              ...folderTrail(allFolders, folder.id).map((step) => ({
                label: step.name,
                link: { to: "/dashboards" as const, search: { folder: step.id } },
              })),
            ]}
          />
        )}
        <div className="browser__header">
          <h2 className="section-title" id={`${searchId}-title`}>
            {where}
            {folder?.ownerTeam ? (
              <span className="browser__restricted">
                <Icon name="members" />
                {t(folder.teamSpace ? "dashboards.team.spaceOf" : "dashboards.team.ownedBy", {
                  team: folder.ownerTeam.name,
                })}
              </span>
            ) : null}
            {folder !== undefined && isRestricted(allFolders, folder.id) && !folder.teamSpace ? (
              <span className="browser__restricted">
                <Icon name="lock" />
                {t("dashboards.folders.restricted")}
              </span>
            ) : null}
          </h2>
        </div>
        <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
        {folder === undefined ? null : (
          <FolderActions
            orgId={orgId}
            folder={folder}
            folders={allFolders}
            onDeleted={(deleted) => {
              showToast({
                message: t("dashboards.folders.deleted", { name: deleted.name }),
                undo: () => restore.mutate(deleted.id),
              });
              void select(undefined);
            }}
          />
        )}
        <div className="dashboards-toolbar">
          <div className="field dashboards-toolbar__search">
            <label className="visually-hidden" htmlFor={searchId}>
              {t("dashboards.search")}
            </label>
            <input
              id={searchId}
              type="search"
              className="input"
              placeholder={t("dashboards.searchPlaceholder")}
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
            />
          </div>
          <ToolbarMenu
            appearance="button"
            label={tagText}
            text={tagText}
            icon="filter"
            entries={tagEntries}
          />
          <ToolbarMenu
            appearance="button"
            label={sortText}
            text={sortText}
            icon="arrowDown"
            entries={sortEntries}
          />
          {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a form fieldset */}
          <div
            className="dashboards-display"
            role="group"
            aria-label={t("dashboards.display.label")}
          >
            {(["list", "tiles"] as const).map((name) => (
              <button
                key={name}
                type="button"
                className="dashboards-display__option"
                aria-pressed={display === name}
                onClick={() => chooseDisplay(name)}
              >
                <Icon name={name === "list" ? "rows" : "dashboards"} />
                {name === "list" ? t("dashboards.display.list") : t("dashboards.display.tiles")}
              </button>
            ))}
          </div>
        </div>
        {showRecents ? (
          <RecentRow orgId={orgId} team={teams.scope} enabled={teams.settled} />
        ) : null}
        <DashboardList
          orgId={orgId}
          meId={userId}
          filter={{
            folderId,
            q: search.q,
            tag: search.tag,
            starred: view === "starred",
            opened: view === "recent",
            sort,
          }}
          view={view}
          display={display}
          folders={allFolders}
          team={teams.scope}
          enabled={teams.settled}
          onClearFilters={clearFilters}
          onCreate={canWrite ? () => setCreating("dashboard") : undefined}
        />
      </section>
      {creating === "dashboard" ? (
        <NewDashboardDialog
          orgId={orgId}
          folders={allFolders}
          folderId={folderId ?? teams.context.defaultFolderId ?? undefined}
          onClose={() => setCreating(null)}
        />
      ) : null}
      {creating === "space" ? (
        <TeamSpaceDialog orgId={orgId} onClose={() => setCreating(null)} onCreated={select} />
      ) : null}
      {creating === "import" ? (
        <ImportDialog orgId={orgId} folderId={folderId ?? null} onClose={() => setCreating(null)} />
      ) : null}
      {creating === "folder" ? (
        <FolderDialog
          orgId={orgId}
          folders={allFolders}
          parentId={folderId ?? null}
          onClose={() => setCreating(null)}
        />
      ) : null}
    </div>
  );
}

/** Tags match in any case, as on the server. */
function sameTag(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** "Sales / Europe": the folders above the dashboard the caller sees, from the top. */
function folderPath(folders: readonly Folder[], id: string | null): string {
  return folderTrail(folders, id)
    .map((step) => step.name)
    .join(" / ");
}

/** The dashboards the caller opened last, as a row of compact links above "All dashboards". */
function RecentRow({
  orgId,
  team,
  enabled,
}: {
  orgId: string;
  team: string | undefined;
  enabled: boolean;
}) {
  const { t, language } = useI18n();
  const headingId = useId();
  const recents = useQuery({ ...recentsQuery(orgId, team), enabled });
  const items = (recents.data?.items ?? []).slice(0, RECENT_LINKS);
  if (items.length === 0) {
    return null;
  }
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const now = Date.now();
  return (
    <section className="dashboards-recent" aria-labelledby={headingId}>
      <h3 className="dashboards-recent__title" id={headingId}>
        {t("dashboards.views.recent")}
      </h3>
      <ul className="dashboards-recent__list">
        {items.map((entry) => (
          <li key={entry.id}>
            <Link
              to="/dashboards/$dashboardId"
              params={{ dashboardId: entry.id }}
              search={{}}
              className="dashboards-recent__link"
            >
              <span className="dashboard-row__mini" aria-hidden="true">
                <Icon name="dashboards" />
              </span>
              <span className="dashboards-recent__text">
                <CutText
                  className="dashboards-recent__name truncate"
                  text={entry.title === "" ? t("dashboards.untitled") : entry.title}
                />
                <CutText
                  className="dashboards-recent__detail truncate"
                  text={relativeTime(relative, entry.at, now, t("dashboards.justNow"))}
                />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function DashboardList({
  orgId,
  meId,
  filter,
  view,
  display,
  folders,
  team,
  enabled,
  onClearFilters,
  onCreate,
}: {
  orgId: string;
  meId: string;
  filter: {
    folderId: string | undefined;
    q: string | undefined;
    tag: string | undefined;
    starred: boolean;
    opened: boolean;
    sort: DashboardSort;
  };
  view: DashboardsSearch["view"];
  display: Display;
  folders: readonly Folder[];
  /** The active team: the list leaves out other teams' spaces. */
  team: string | undefined;
  enabled: boolean;
  /** Empties the search field and drops the tag (a search or filter that found nothing). */
  onClearFilters: () => void;
  /** Opens "New dashboard" here; absent without the right to create one. */
  onCreate: (() => void) | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const queryClient = useQueryClient();
  const tiles = display === "tiles";
  const list = useInfiniteQuery({
    queryKey: [DASHBOARDS_KEY, orgId, "list", { ...filter, team: team ?? null, tiles }],
    queryFn: ({ pageParam, signal }) =>
      fetchDashboards(orgId, { ...filter, team, layout: tiles, cursor: pageParam }, signal),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A new search keeps showing the previous results until its own arrive, without "Loading".
    placeholderData: keepPreviousData,
  });
  const star = useMutation({
    mutationFn: async (item: DashboardSummary) => {
      const starred = item.starred !== true;
      await setStarred(orgId, item.id, starred);
      return starred;
    },
    onSuccess: async (starred, item) => {
      // The row and the Favorites count change in place; the other lists keep what they hold.
      queryClient.setQueriesData<InfiniteData<ResultPage<DashboardSummary>>>(
        { queryKey: [DASHBOARDS_KEY, orgId, "list"] },
        (data) =>
          data === undefined
            ? data
            : {
                ...data,
                pages: data.pages.map((page) => ({
                  ...page,
                  items: page.items.map((row) => (row.id === item.id ? { ...row, starred } : row)),
                })),
              },
      );
      queryClient.setQueriesData<DashboardCounts>(
        { queryKey: [DASHBOARDS_KEY, orgId, "counts"] },
        (data) =>
          data === undefined
            ? data
            : { ...data, starred: Math.max(0, data.starred + (starred ? 1 : -1)) },
      );
      // The Favorites list itself and the start page's stars follow the change.
      await queryClient.invalidateQueries({
        queryKey: [DASHBOARDS_KEY, orgId, "list"],
        predicate: (query) =>
          (query.queryKey[3] as { starred?: boolean } | undefined)?.starred === true,
      });
      await queryClient.invalidateQueries({ queryKey: [HOME_KEY, orgId] });
    },
  });
  const dateFormat = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    timeStyle: "short",
    ...zoneOption(timeZone),
  });
  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const now = Date.now();

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  const items = list.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    const filtered = filter.q !== undefined || filter.tag !== undefined;
    if (filtered) {
      return (
        <EmptyState
          icon="search"
          title={t("dashboards.empty.search")}
          actions={
            <button type="button" className="button button--secondary" onClick={onClearFilters}>
              {filter.tag === undefined
                ? t("dashboards.empty.clearSearch")
                : t("dashboards.empty.clearFilters")}
            </button>
          }
        >
          {filter.tag === undefined
            ? t("dashboards.empty.searchText")
            : t("dashboards.empty.filterText")}
        </EmptyState>
      );
    }
    if (view !== undefined) {
      return (
        <EmptyState
          icon={view === "starred" ? "star" : "clock"}
          title={
            view === "starred"
              ? t("dashboards.empty.starredTitle")
              : t("dashboards.empty.recentTitle")
          }
        >
          {view === "starred"
            ? t("dashboards.empty.starredText")
            : t("dashboards.empty.recentText")}
        </EmptyState>
      );
    }
    return (
      <EmptyState
        icon="dashboards"
        title={t("dashboards.empty.title")}
        actions={
          onCreate !== undefined ? (
            <button type="button" className="button button--secondary" onClick={onCreate}>
              <Icon name="plus" />
              {t("dashboards.empty.create")}
            </button>
          ) : undefined
        }
      >
        {t("dashboards.empty.text")}
      </EmptyState>
    );
  }
  const titleOf = (item: DashboardSummary) =>
    item.title === "" ? t("dashboards.untitled") : item.title;
  const changedBy = (item: DashboardSummary) => {
    if (item.updatedBy === undefined || item.updatedBy === null) return "";
    if (item.updatedBy === meId) return t("dashboards.byYou");
    return item.updatedByName === undefined || item.updatedByName === null
      ? ""
      : t("dashboards.updatedBy", { name: item.updatedByName });
  };
  const changed = (item: DashboardSummary) =>
    item.updatedAt > 0 ? relativeTime(relative, item.updatedAt, now, t("dashboards.justNow")) : "";
  const starButton = (item: DashboardSummary) => (
    <button
      type="button"
      className="dashboard-star"
      aria-pressed={item.starred === true}
      aria-label={t("dashboards.star.toggle", { title: titleOf(item) })}
      title={t("dashboards.star.toggle", { title: titleOf(item) })}
      disabled={star.isPending && star.variables?.id === item.id}
      onClick={() => star.mutate(item)}
    >
      <Icon name={item.starred === true ? "starFilled" : "star"} />
    </button>
  );
  const teamNote = (item: DashboardSummary) =>
    item.ownerTeam === null ? null : (
      <span className="dashboard-list__team">
        <Icon name="members" />
        {t(item.teamOnly ? "dashboards.team.onlyTeam" : "dashboards.team.ownedBy", {
          team: item.ownerTeam.name,
        })}
      </span>
    );

  return (
    <>
      <FormAlert>{star.isError ? errorMessage(t, star.error) : null}</FormAlert>
      {tiles ? (
        <ul className="dashboard-tiles">
          {items.map((item) => {
            const path = folderPath(folders, item.folderId);
            const time = changed(item);
            return (
              <li key={item.id} className="dashboard-tile">
                <DashboardSketch layout={item.layout} />
                <div className="dashboard-tile__meta">
                  <div className="dashboard-tile__top">
                    <Link
                      to="/dashboards/$dashboardId"
                      params={{ dashboardId: item.id }}
                      search={{}}
                      className="dashboard-tile__link truncate"
                      title={titleOf(item)}
                    >
                      {titleOf(item)}
                    </Link>
                    {starButton(item)}
                  </div>
                  <CutText
                    className="dashboard-tile__detail truncate"
                    text={[path, time].filter((part) => part !== "").join(" · ")}
                  />
                  {teamNote(item)}
                </div>
              </li>
            );
          })}
        </ul>
      ) : (
        <table className="data-table data-table--stack dashboard-table" {...STACK_ROLES.table}>
          <thead {...STACK_ROLES.rowgroup}>
            <tr {...STACK_ROLES.row}>
              <th scope="col" {...STACK_ROLES.columnheader} className="dashboard-table__star">
                <span className="visually-hidden">{t("dashboards.column.star")}</span>
              </th>
              <th
                scope="col"
                {...STACK_ROLES.columnheader}
                aria-sort={filter.sort === "title" ? "ascending" : undefined}
              >
                {t("dashboards.column.name")}
              </th>
              <th scope="col" {...STACK_ROLES.columnheader}>
                {t("dashboards.column.folder")}
              </th>
              <th scope="col" {...STACK_ROLES.columnheader}>
                {t("dashboards.column.tags")}
              </th>
              <th
                scope="col"
                {...STACK_ROLES.columnheader}
                aria-sort={filter.sort === "updated" ? "descending" : undefined}
              >
                {t("dashboards.column.changed")}
              </th>
            </tr>
          </thead>
          <tbody {...STACK_ROLES.rowgroup}>
            {items.map((item) => {
              const by = changedBy(item);
              return (
                <tr key={item.id} className="dashboard-row" {...STACK_ROLES.row}>
                  <td {...STACK_ROLES.cell} className="dashboard-table__star">
                    {starButton(item)}
                  </td>
                  <td {...STACK_ROLES.cell}>
                    <span className="dashboard-row__title">
                      <span className="dashboard-row__mini" aria-hidden="true">
                        <Icon name="dashboards" />
                      </span>
                      {/* The link covers the whole row for the pointer; the star stays above it. */}
                      <Link
                        to="/dashboards/$dashboardId"
                        params={{ dashboardId: item.id }}
                        search={{}}
                        className="dashboard-row__link"
                      >
                        {titleOf(item)}
                      </Link>
                    </span>
                    {teamNote(item)}
                  </td>
                  {/* Optional: a dashboard outside any folder leaves no empty line on a phone. */}
                  <td
                    {...STACK_ROLES.cell}
                    className="data-table__muted data-table__optional"
                    data-label={t("dashboards.column.folder")}
                  >
                    {folderPath(folders, item.folderId)}
                  </td>
                  <td
                    {...STACK_ROLES.cell}
                    className="data-table__optional"
                    data-label={t("dashboards.column.tags")}
                  >
                    {(item.tags ?? []).length === 0 ? null : (
                      <span className="dashboard-tags">
                        {(item.tags ?? []).map((tag) => (
                          <span key={tag} className="dashboard-tag">
                            {tag}
                          </span>
                        ))}
                      </span>
                    )}
                  </td>
                  <td
                    {...STACK_ROLES.cell}
                    className="data-table__muted dashboard-row__changed"
                    data-label={t("dashboards.column.changed")}
                  >
                    {item.updatedAt > 0 ? (
                      <time
                        dateTime={new Date(item.updatedAt).toISOString()}
                        title={dateFormat.format(item.updatedAt)}
                      >
                        {changed(item)}
                      </time>
                    ) : null}
                    {by === "" ? null : ` · ${by}`}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
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
      <Select id={id} value={value ?? ""} onChange={(next) => onChange(next === "" ? null : next)}>
        <option value="">{t("dashboards.folders.none")}</option>
        {folders
          .filter((f) => exclude?.has(f.id) !== true)
          .map((f) => (
            <option key={f.id} value={f.id}>
              {f.name}
            </option>
          ))}
      </Select>
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
