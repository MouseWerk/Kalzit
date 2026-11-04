import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate, useRouter } from "@tanstack/react-router";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useRef, useState } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page, PageActions } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { ToolbarMenu, type ToolbarMenuEntry } from "../../components/ToolbarMenu";
import { useI18n } from "../../i18n/i18n";
import { writeClipboard } from "../../lib/clipboard";
import { stillOnRoute } from "../../lib/stillOnRoute";
import { showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useTeamContext } from "../../org/teamContext";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { relativeTime } from "../../shell/startData";
import { initialsOf } from "../../shell/UserMenu";
import { type Folder, foldersQuery } from "../dashboards/api";
import { FolderTree } from "../dashboards/FolderTree";
import { newPanelId, type PanelModel } from "../dashboards/model";
import { ConfirmDialog, Dialog } from "../dashboards/ui/Dialog";
import { errorMessage } from "../dashboards/ui/errors";
import { datasourcesQuery } from "../datasources/api";
import { KindMark, kindSummary } from "../datasources/kindMarks";
import { AddToDashboardDialog } from "../explore/AddToDashboardDialog";
import {
  ANALYSES_KEY,
  type Analysis,
  type AnalysisSort,
  createAnalysis,
  fetchAnalyses,
  fetchAnalysis,
  fetchCounts,
  fetchUses,
  restoreAnalysis,
  saveAnalysis,
  trashAnalysis,
} from "./api";
import { placeLabel } from "./places";
import { SaveAnalysisDialog } from "./SaveAnalysisDialog";
import "../dashboards/dashboards.css";
import "./analyses.css";
import { Select } from "../../components/Select";

const listRoute = getRouteApi("/_app/explore/saved");
const appRoute = getRouteApi("/_app");

/** Pause in typing after which the search runs. */
const SEARCH_DELAY_MS = 250;

export function AnalysesPage() {
  const { t } = useI18n();
  useDocumentTitle("analyses.list.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  let body = null;
  if (org !== undefined && permissions.has("analyses:read")) {
    body = <AnalysisBrowser orgId={org.id} />;
  } else if (permissions.loaded) {
    body = (
      <EmptyState icon="lock" title={t("analyses.forbidden.title")}>
        {t("analyses.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("analyses.list.title")} lead={t("analyses.list.lead")}>
      <Breadcrumbs
        crumbs={[
          { label: t("explore.nav"), link: { to: "/explore", search: {} } },
          { label: t("analyses.list.title") },
        ]}
      />
      {body}
    </Page>
  );
}

/** A linked panel for a dashboard: the slot names the analysis, its look starts from there. */
export function linkedPanel(analysis: Analysis): PanelModel {
  const model = analysis.model;
  return {
    id: newPanelId(),
    type: model?.visualization.type ?? "table",
    title: analysis.title,
    grid: { x: 0, y: 0, w: 24, h: 9 },
    targets: model?.targets ?? [],
    transformations: model?.steps ?? [],
    options: model?.visualization.options ?? {},
    fieldConfig: model?.visualization.fieldConfig ?? {},
    analysisId: analysis.id,
    ...(model?.description === undefined ? {} : { description: model.description }),
  };
}

type RowDialog =
  | { kind: "moveHere"; folder: Folder }
  | { kind: "move"; analysis: Analysis }
  | { kind: "trash"; analysis: Analysis }
  | { kind: "uses"; analysis: Analysis }
  | { kind: "dashboard"; analysis: Analysis };

function AnalysisBrowser({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const me = appRoute.useRouteContext().me;
  const search = listRoute.useSearch();
  const navigate = listRoute.useNavigate();
  const router = useRouter();
  const searchId = useId();
  const teams = useTeamContext();
  const folders = useQuery({
    ...foldersQuery(orgId, teams.scope),
    enabled: teams.settled && permissions.has("folders:read"),
  });
  const sources = useQuery(datasourcesQuery(orgId));
  // The numbers beside the folders and on the trash, without the list's filters.
  const counts = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "counts", teams.scope ?? null],
    queryFn: ({ signal }) => fetchCounts(orgId, { team: teams.scope }, signal),
    enabled: teams.settled,
  });
  const [query, setQuery] = useState(search.q ?? "");
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      // An analysis opened within the pause leaves the list while it still shows (its page is
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
  // "/" jumps to the search, as in the other lists.
  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      const target = event.target;
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));
      if (event.key === "/" && !typing && !event.defaultPrevented) {
        event.preventDefault();
        searchRef.current?.focus();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const allFolders = folders.data ?? [];
  const folder = allFolders.find((f) => f.id === search.folder);
  const where =
    folder === undefined ? t("analyses.list.all") : placeLabel(t, allFolders, folder.id);
  const select = (id: string | undefined) =>
    navigate({ search: (prev) => ({ ...prev, folder: id }), replace: true });
  const filtered =
    search.q !== undefined ||
    search.source !== undefined ||
    search.mine === true ||
    search.ownerTeam !== undefined;
  // The owner filter: everyone, the caller, or one of the caller's teams.
  const myTeams = teams.context.teams.filter((team) => team.member);

  return (
    <div className="analyses-layout">
      <PageActions>
        <Link to="/explore/saved/trash" className="button button--ghost">
          <Icon name="trash" />
          {t("analyses.trash.link")}
          {counts.data === undefined || counts.data.trashed === 0 ? null : (
            <span className="analyses-count">{counts.data.trashed}</span>
          )}
        </Link>
        {permissions.has("datasources:query") ? (
          <Link to="/explore" search={{}} className="button button--secondary">
            <Icon name="explore" />
            {t("analyses.list.newInExplore")}
          </Link>
        ) : null}
      </PageActions>
      <div className="browser analyses-browser">
        <aside className="browser__side">
          {folders.isError ? (
            <FormAlert>{errorMessage(t, folders.error)}</FormAlert>
          ) : (
            <FolderTree
              folders={allFolders}
              selected={search.folder}
              onSelect={select}
              storageKey={`kalzit.analysisTree.${me.id}`}
              activeTeam={teams.scope}
              allLabel={t("analyses.list.all")}
              counts={
                counts.data === undefined
                  ? undefined
                  : { all: counts.data.total, folders: counts.data.folders }
              }
            />
          )}
        </aside>
        <section className="browser__main" aria-labelledby={`${searchId}-title`}>
          <div className="browser__header">
            <h2 className="section-title" id={`${searchId}-title`}>
              {where}
            </h2>
          </div>
          <div className="analysis-filters">
            <div className="field analysis-filters__search">
              <label className="visually-hidden" htmlFor={searchId}>
                {t("analyses.list.search")}
              </label>
              <input
                ref={searchRef}
                id={searchId}
                type="search"
                className="input"
                placeholder={t("analyses.list.searchPlaceholder")}
                value={query}
                onChange={(event) => setQuery(event.currentTarget.value)}
              />
            </div>
            <div className="preference">
              <label htmlFor={`${searchId}-source`}>{t("analyses.list.source")}</label>
              <Select
                id={`${searchId}-source`}
                value={search.source ?? ""}
                onChange={(next) => {
                  const value = next;
                  void navigate({
                    search: (prev) => ({ ...prev, source: value === "" ? undefined : value }),
                    replace: true,
                  });
                }}
              >
                <option value="">{t("analyses.list.any")}</option>
                {(sources.data ?? []).map((source) => (
                  <option key={source.id} value={source.id}>
                    {source.name}
                  </option>
                ))}
              </Select>
            </div>
            <div className="preference">
              <label htmlFor={`${searchId}-owner`}>{t("analyses.list.owner")}</label>
              <Select
                id={`${searchId}-owner`}
                value={
                  search.mine === true
                    ? "me"
                    : search.ownerTeam === undefined
                      ? ""
                      : `team:${search.ownerTeam}`
                }
                onChange={(value) => {
                  const mine = value === "me" ? true : undefined;
                  const ownerTeam = value.startsWith("team:") ? value.slice(5) : undefined;
                  void navigate({
                    search: (prev) => ({ ...prev, mine, ownerTeam }),
                    replace: true,
                  });
                }}
              >
                <option value="">{t("analyses.list.any")}</option>
                <option value="me">{t("analyses.list.me")}</option>
                {myTeams.map((team) => (
                  <option key={team.id} value={`team:${team.id}`}>
                    {t("analyses.list.teamOption", { team: team.name })}
                  </option>
                ))}
              </Select>
            </div>
            <div className="preference analysis-filters__sort">
              <label htmlFor={`${searchId}-sort`}>{t("analyses.list.sort")}</label>
              <Select
                id={`${searchId}-sort`}
                value={search.sort ?? "updated"}
                onChange={(next) => {
                  const sort = next === "title" || next === "opened" ? next : undefined;
                  void navigate({ search: (prev) => ({ ...prev, sort }), replace: true });
                }}
              >
                <option value="updated">{t("analyses.list.sortUpdated")}</option>
                <option value="title">{t("analyses.list.sortTitle")}</option>
                <option value="opened">{t("analyses.list.sortOpened")}</option>
              </Select>
            </div>
          </div>
          <AnalysisList
            orgId={orgId}
            meId={me.id}
            meName={me.name}
            folders={allFolders}
            folderId={search.folder}
            where={where}
            q={search.q}
            source={search.source}
            mine={search.mine === true}
            ownerTeam={search.ownerTeam}
            sort={search.sort ?? "updated"}
            team={teams.scope}
            enabled={teams.settled}
            filtered={filtered}
            onSearchEverywhere={() => void select(undefined)}
            onReset={() => {
              setQuery("");
              void navigate({ search: { folder: search.folder }, replace: true });
            }}
          />
        </section>
      </div>
    </div>
  );
}

interface AnalysisListProps {
  orgId: string;
  meId: string;
  /** The caller's name, for their own avatar in the owner column. */
  meName: string;
  folders: readonly Folder[];
  folderId: string | undefined;
  /** The selected place, as the heading names it. */
  where: string;
  q: string | undefined;
  source: string | undefined;
  mine: boolean;
  /** Only analyses this team owns. */
  ownerTeam: string | undefined;
  sort: AnalysisSort;
  team: string | undefined;
  enabled: boolean;
  filtered: boolean;
  onSearchEverywhere: () => void;
  onReset: () => void;
}

export function AnalysisList({
  orgId,
  meId,
  meName,
  folders,
  folderId,
  where,
  q,
  source,
  mine,
  ownerTeam,
  sort,
  team,
  enabled,
  filtered,
  onSearchEverywhere,
  onReset,
}: AnalysisListProps) {
  const { t, language } = useI18n();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const permissions = useOrgPermissions();
  const tableRef = useRef<HTMLTableElement>(null);
  const [dialog, setDialog] = useState<RowDialog | null>(null);
  const [rowError, setRowError] = useState<string | null>(null);
  const list = useInfiniteQuery({
    queryKey: [
      ANALYSES_KEY,
      orgId,
      "list",
      folderId ?? null,
      q ?? "",
      source ?? null,
      mine,
      ownerTeam ?? null,
      sort,
      team ?? null,
    ],
    queryFn: ({ pageParam, signal }) =>
      fetchAnalyses(
        orgId,
        {
          folderId,
          q,
          datasourceId: source,
          createdBy: mine ? meId : undefined,
          // "Me" is what the caller created and no team owns.
          ownerTeamId: mine ? "none" : ownerTeam,
          sort,
          team,
          cursor: pageParam,
        },
        signal,
      ),
    enabled,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  const sources = useQuery(datasourcesQuery(orgId));
  // A search without matches in one place says how many the other places hold.
  const emptyHere =
    folderId !== undefined && filtered && list.data?.pages.every((p) => p.items.length === 0);
  const everywhere = useQuery({
    queryKey: [
      ANALYSES_KEY,
      orgId,
      "counts",
      team ?? null,
      q ?? "",
      source ?? null,
      mine,
      ownerTeam ?? null,
    ],
    queryFn: ({ signal }) =>
      fetchCounts(
        orgId,
        {
          q,
          team,
          datasourceId: source,
          createdBy: mine ? meId : undefined,
          ownerTeamId: mine ? "none" : ownerTeam,
        },
        signal,
      ),
    enabled: enabled && emptyHere === true,
  });
  const refresh = () => queryClient.invalidateQueries({ queryKey: [ANALYSES_KEY, orgId] });
  const restore = useMutation({
    mutationFn: (id: string) => restoreAnalysis(orgId, id),
    onSettled: refresh,
  });
  const duplicate = useMutation({
    mutationFn: async (analysis: Analysis) => {
      const full = await fetchAnalysis(orgId, analysis.id);
      if (full.model === undefined) {
        throw new Error("no model");
      }
      return createAnalysis(orgId, {
        folderId: full.folderId,
        model: { ...full.model, title: t("analyses.list.copyOf", { title: full.title }) },
      });
    },
    onSuccess: async (created) => {
      setRowError(null);
      showToast({ message: t("analyses.list.duplicated", { title: created.title }) });
      await refresh();
    },
    onError: (error) => setRowError(errorMessage(t, error)),
  });
  const move = useMutation({
    mutationFn: async ({
      analysis,
      folderId: to,
    }: {
      analysis: Analysis;
      folderId: string | null;
    }) => {
      const full = await fetchAnalysis(orgId, analysis.id);
      if (full.model === undefined) {
        throw new Error("no model");
      }
      return saveAnalysis(orgId, analysis.id, {
        model: full.model,
        version: full.version,
        folderId: to,
      });
    },
    onSuccess: async (saved) => {
      setDialog(null);
      showToast({
        message: t("analyses.list.moved", {
          title: saved.title,
          place: placeLabel(t, folders, saved.folderId),
        }),
      });
      await refresh();
    },
  });
  const trash = useMutation({
    mutationFn: (analysis: Analysis) => trashAnalysis(orgId, analysis.id),
    onSuccess: async (_, analysis) => {
      setDialog(null);
      showToast({
        message: t("analyses.list.trashed", { title: analysis.title }),
        undo: () => restore.mutate(analysis.id),
      });
      await refresh();
    },
  });
  const toDashboard = useMutation({
    mutationFn: (analysis: Analysis) => fetchAnalysis(orgId, analysis.id),
    onSuccess: (full) => setDialog({ kind: "dashboard", analysis: full }),
    onError: (error) => setRowError(errorMessage(t, error)),
  });

  const relative = new Intl.RelativeTimeFormat(language, { numeric: "auto", style: "short" });
  const now = Date.now();
  // The list names who created and who saved; a removed account has no name any more.
  const nameOf = (id: string | null, name: string | null) => {
    if (id === null) return "";
    if (id === meId) return t("analyses.list.you");
    return name ?? t("analyses.list.unknownPerson");
  };

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  const items = list.data.pages.flatMap((page) => page.items);
  if (items.length === 0) {
    if (filtered) {
      const elsewhere = everywhere.data?.total;
      return (
        <EmptyState
          icon="search"
          title={q === undefined ? t("analyses.empty.filtered") : t("analyses.empty.search", { q })}
          actions={
            <>
              {folderId === undefined || elsewhere === 0 ? null : (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={onSearchEverywhere}
                >
                  {t("analyses.empty.everywhere")}
                </button>
              )}
              <button type="button" className="button button--secondary" onClick={onReset}>
                {t("analyses.empty.reset")}
              </button>
            </>
          }
        >
          {t("analyses.empty.searchText", { place: where })}
          {folderId === undefined || elsewhere === undefined
            ? null
            : ` ${
                elsewhere === 0
                  ? t("analyses.empty.elsewhereNone")
                  : t(
                      elsewhere === 1
                        ? "analyses.empty.elsewhereOne"
                        : "analyses.empty.elsewhereMany",
                      { count: elsewhere },
                    )
              }`}
        </EmptyState>
      );
    }
    const target = folders.find((f) => f.id === folderId);
    return (
      <>
        <EmptyState
          icon="explore"
          title={t("analyses.empty.title", { place: where })}
          actions={
            <>
              {permissions.has("datasources:query") ? (
                <Link to="/explore" search={{}} className="button button--secondary">
                  <Icon name="explore" />
                  {t("analyses.empty.openExplore")}
                </Link>
              ) : null}
              {target !== undefined &&
              permissions.has("analyses:write") &&
              target.access?.write !== false ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setDialog({ kind: "moveHere", folder: target })}
                >
                  {t("analyses.empty.moveHere")}
                </button>
              ) : null}
            </>
          }
        >
          {t("analyses.empty.text")}
        </EmptyState>
        {dialog?.kind === "moveHere" ? (
          <MoveHereDialog
            orgId={orgId}
            folder={dialog.folder}
            folders={folders}
            team={team}
            onClose={() => setDialog(null)}
            onMoved={refresh}
          />
        ) : null}
      </>
    );
  }

  const sourceOf = (analysis: Analysis) =>
    sources.data?.find((s) => s.id === analysis.datasourceIds[0]);

  /** J and K move between the rows' names, as the list's footer says. */
  function onKeyDown(event: KeyboardEvent<HTMLTableElement>) {
    if (event.key !== "j" && event.key !== "k") {
      return;
    }
    const links = Array.from(
      tableRef.current?.querySelectorAll<HTMLAnchorElement>("a.analysis-row__name") ?? [],
    );
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    const next = links[event.key === "j" ? index + 1 : Math.max(index - 1, 0)];
    if (next !== undefined) {
      event.preventDefault();
      next.focus();
    }
  }

  function entries(analysis: Analysis): ToolbarMenuEntry[] {
    const list: ToolbarMenuEntry[] = [
      analysis.mayQuery
        ? {
            key: "open",
            label: t("analyses.row.open"),
            icon: "explore",
            onSelect: () => void navigate({ to: "/explore", search: { analysis: analysis.id } }),
          }
        : {
            key: "view",
            label: t("analyses.row.view"),
            icon: "eye",
            onSelect: () =>
              void navigate({
                to: "/explore/saved/$analysisId",
                params: { analysisId: analysis.id },
              }),
          },
    ];
    if (permissions.has("dashboards:write")) {
      list.push({
        key: "dashboard",
        label: t("analyses.row.addToDashboard"),
        icon: "dashboards",
        onSelect: () => toDashboard.mutate(analysis),
      });
    }
    if (permissions.has("analyses:write")) {
      list.push({
        key: "duplicate",
        label: t("analyses.row.duplicate"),
        icon: "copy",
        onSelect: () => duplicate.mutate(analysis),
      });
    }
    if (analysis.access.write) {
      list.push({
        key: "move",
        label: t("analyses.row.move"),
        icon: "folder",
        onSelect: () => {
          move.reset();
          setDialog({ kind: "move", analysis });
        },
      });
    }
    list.push(
      {
        key: "link",
        label: t("analyses.row.copyLink"),
        icon: "link",
        onSelect: () => {
          const url = new URL(
            `/explore?analysis=${encodeURIComponent(analysis.id)}`,
            window.location.origin,
          );
          void writeClipboard(url.toString()).then((done) =>
            showToast({
              message: done ? t("analyses.row.linkCopied") : t("analyses.row.linkFailed"),
            }),
          );
        },
      },
      {
        key: "versions",
        label: t("analyses.row.versions"),
        icon: "history",
        onSelect: () =>
          void navigate({
            to: "/explore/saved/$analysisId/versions",
            params: { analysisId: analysis.id },
          }),
      },
    );
    if (analysis.access.delete || analysis.access.write) {
      list.push(
        { kind: "separator", key: "sep" },
        {
          key: "trash",
          label: t("analyses.row.trash"),
          icon: "trash",
          danger: true,
          onSelect: () => {
            trash.reset();
            setDialog({ kind: "trash", analysis });
          },
        },
      );
    }
    return list;
  }

  return (
    <>
      <FormAlert>{rowError}</FormAlert>
      <table
        ref={tableRef}
        className="data-table data-table--stack analysis-table"
        onKeyDown={onKeyDown}
        {...STACK_ROLES.table}
      >
        <thead {...STACK_ROLES.rowgroup}>
          <tr {...STACK_ROLES.row}>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.column.name")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.column.source")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.column.owner")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              {t("analyses.column.uses")}
            </th>
            <th
              scope="col"
              {...STACK_ROLES.columnheader}
              aria-sort={sort === "updated" ? "descending" : undefined}
            >
              {t("analyses.column.updated")}
            </th>
            <th scope="col" {...STACK_ROLES.columnheader}>
              <span className="visually-hidden">{t("analyses.column.actions")}</span>
            </th>
          </tr>
        </thead>
        <tbody {...STACK_ROLES.rowgroup}>
          {items.map((item) => {
            const datasource = sourceOf(item);
            const updatedBy = nameOf(item.updatedBy, item.updatedByName);
            return (
              <tr key={item.id} {...STACK_ROLES.row}>
                <td {...STACK_ROLES.cell}>
                  <div className="analysis-row__title">
                    {item.mayQuery ? (
                      <Link
                        to="/explore"
                        search={{ analysis: item.id }}
                        className="analysis-row__name"
                      >
                        {item.title}
                      </Link>
                    ) : (
                      <Link
                        to="/explore/saved/$analysisId"
                        params={{ analysisId: item.id }}
                        className="analysis-row__name"
                      >
                        {item.title}
                      </Link>
                    )}
                    <span className="analysis-row__detail">
                      {placeLabel(t, folders, item.folderId)}
                      {item.ownerTeam === null
                        ? ""
                        : ` · ${t(item.teamOnly ? "analyses.list.teamOnly" : "analyses.list.ownedBy", { team: item.ownerTeam.name })}`}
                    </span>
                  </div>
                </td>
                <td {...STACK_ROLES.cell} data-label={t("analyses.column.source")}>
                  {datasource === undefined ? (
                    <span className="data-table__muted">
                      {item.datasourceIds.length === 0 ? "" : t("analyses.list.sourceHidden")}
                    </span>
                  ) : (
                    <span className="analysis-row__source">
                      <KindMark kind={datasource.kind} small />
                      <span className="analysis-row__title">
                        <span>{datasource.name}</span>
                        <span className="analysis-row__detail">
                          {item.mayQuery
                            ? (kindSummary(t, datasource.kind) ?? datasource.kind)
                            : t("analyses.list.noQueryRight")}
                        </span>
                      </span>
                    </span>
                  )}
                </td>
                <td {...STACK_ROLES.cell} data-label={t("analyses.column.owner")}>
                  {item.ownerTeam !== null ? (
                    // A team that owns the analysis is its owner, before whoever created it.
                    <span className="analysis-row__owner">
                      <span className="analysis-row__avatar" aria-hidden="true">
                        {initialsOf(item.ownerTeam.name)}
                      </span>
                      {item.ownerTeam.name}
                      <span className="visually-hidden">{`, ${t("analyses.list.ownerTeam")}`}</span>
                    </span>
                  ) : item.createdBy === null ? null : (
                    <span className="analysis-row__owner">
                      <span className="analysis-row__avatar" aria-hidden="true">
                        {initialsOf(
                          item.createdBy === meId
                            ? meName
                            : (item.createdByName ?? t("analyses.list.unknownPerson")),
                        )}
                      </span>
                      {nameOf(item.createdBy, item.createdByName)}
                    </span>
                  )}
                </td>
                <td {...STACK_ROLES.cell} data-label={t("analyses.column.uses")}>
                  {item.uses === 0 ? (
                    <span className="data-table__muted analysis-row__nowrap">
                      {t("analyses.list.unused")}
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => setDialog({ kind: "uses", analysis: item })}
                    >
                      {t(item.uses === 1 ? "analyses.list.usesOne" : "analyses.list.usesMany", {
                        count: item.uses,
                      })}
                    </button>
                  )}
                </td>
                <td {...STACK_ROLES.cell} data-label={t("analyses.column.updated")}>
                  <span className="analysis-row__title">
                    <span>
                      {relativeTime(relative, item.updatedAt, now, t("analyses.justNow"))}
                    </span>
                    {updatedBy === "" ? null : (
                      <span className="analysis-row__detail">
                        {item.updatedBy === meId
                          ? t("analyses.list.byYou")
                          : t("analyses.list.by", { name: updatedBy })}
                      </span>
                    )}
                  </span>
                </td>
                <td {...STACK_ROLES.cell} className="data-table__actions">
                  <span className="analysis-row__actions">
                    {item.mayQuery ? (
                      <Link
                        to="/explore"
                        search={{ analysis: item.id }}
                        className="button button--secondary button--small"
                        aria-label={t("analyses.row.openNamed", { title: item.title })}
                      >
                        {t("analyses.row.openShort")}
                      </Link>
                    ) : (
                      // Without the query right: the analysis to look at and run, not to edit.
                      <Link
                        to="/explore/saved/$analysisId"
                        params={{ analysisId: item.id }}
                        className="button button--secondary button--small"
                        aria-label={t("analyses.row.openShortNamed", { title: item.title })}
                        title={t("analyses.row.openReadOnly", {
                          source: datasource?.name ?? t("analyses.list.sourceHidden"),
                        })}
                      >
                        {t("analyses.row.openShort")}
                      </Link>
                    )}
                    <ToolbarMenu
                      label={t("analyses.row.actions", { title: item.title })}
                      icon="more"
                      entries={entries(item)}
                    />
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="analysis-table__foot">
        <span>
          {t(items.length === 1 ? "analyses.list.countOne" : "analyses.list.countMany", {
            count: items.length,
            place: where,
          })}
        </span>
        <span className="analysis-table__keys">{t("analyses.list.keys")}</span>
      </div>
      {list.hasNextPage ? (
        <button
          type="button"
          className="button button--secondary"
          onClick={() => void list.fetchNextPage()}
          disabled={list.isFetchingNextPage}
        >
          {t("analyses.list.loadMore")}
        </button>
      ) : null}
      {dialog?.kind === "move" ? (
        <SaveAnalysisDialog
          mode="move"
          initial={{
            title: dialog.analysis.title,
            description: "",
            folderId: dialog.analysis.folderId,
            keepRange: false,
          }}
          folders={folders}
          canTop={permissions.has("analyses:write")}
          busy={move.isPending}
          error={move.isError ? errorMessage(t, move.error) : undefined}
          onSubmit={(values) =>
            move.mutate({ analysis: dialog.analysis, folderId: values.folderId })
          }
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "trash" ? (
        <TrashDialog
          orgId={orgId}
          analysis={dialog.analysis}
          busy={trash.isPending}
          error={trash.isError ? errorMessage(t, trash.error) : undefined}
          onConfirm={() => trash.mutate(dialog.analysis)}
          onCancel={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === "uses" ? (
        <UsesDialog orgId={orgId} analysis={dialog.analysis} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === "dashboard" ? (
        <AddToDashboardDialog
          orgId={orgId}
          panel={linkedPanel(dialog.analysis)}
          range={dialog.analysis.model?.timeRange ?? { from: "now-6h", to: "now" }}
          onClose={() => setDialog(null)}
        />
      ) : null}
    </>
  );
}

/** The dashboards that link an analysis, as far as the caller may read them. */
function useUses(orgId: string, analysis: Analysis) {
  return useQuery({
    queryKey: [ANALYSES_KEY, orgId, "uses", analysis.id],
    queryFn: ({ signal }) => fetchUses(orgId, analysis.id, signal),
    enabled: analysis.uses > 0,
  });
}

function UseLinks({ orgId, analysis }: { orgId: string; analysis: Analysis }) {
  const { t } = useI18n();
  const uses = useUses(orgId, analysis);
  if (uses.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (uses.isError) {
    return <FormAlert>{errorMessage(t, uses.error)}</FormAlert>;
  }
  return (
    <ul className="analysis-uses">
      {uses.data.map((use) => (
        <li key={use.id}>
          <Link to="/dashboards/$dashboardId" params={{ dashboardId: use.id }} search={{}}>
            {use.title === "" ? t("dashboards.untitled") : use.title}
          </Link>
          {use.deletedAt === null ? null : (
            <span className="data-table__muted"> {t("analyses.uses.inTrash")}</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function UsesDialog({
  orgId,
  analysis,
  onClose,
}: {
  orgId: string;
  analysis: Analysis;
  onClose: () => void;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      title={t("analyses.uses.title", { title: analysis.title })}
      onClose={onClose}
      actions={
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("analyses.dialog.close")}
        </button>
      }
    >
      <p>{t("analyses.uses.text")}</p>
      <UseLinks orgId={orgId} analysis={analysis} />
    </Dialog>
  );
}

/**
 * Moving to the trash names the dashboards that show the analysis first: while any links it, the
 * server keeps it, so the dialog says where to remove the link instead.
 */
export function TrashDialog({
  orgId,
  analysis,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  orgId: string;
  analysis: Analysis;
  busy: boolean;
  error: string | undefined;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const { t } = useI18n();
  if (analysis.uses > 0) {
    return (
      <Dialog
        title={t("analyses.trash.confirmTitle")}
        onClose={onCancel}
        actions={
          <button type="button" className="button button--secondary" onClick={onCancel}>
            {t("analyses.dialog.close")}
          </button>
        }
      >
        <p>{t("analyses.trash.inUse", { title: analysis.title })}</p>
        <UseLinks orgId={orgId} analysis={analysis} />
      </Dialog>
    );
  }
  return (
    <ConfirmDialog
      title={t("analyses.trash.confirmTitle")}
      confirmLabel={t("analyses.trash.confirm")}
      onConfirm={onConfirm}
      onCancel={onCancel}
      busy={busy}
      error={error}
    >
      {t("analyses.trash.confirmText", { title: analysis.title })}
    </ConfirmDialog>
  );
}

/**
 * "Move from another place" for an empty folder: the analyses elsewhere that the caller may
 * move, searchable, each moved here with one click. The server checks the right on both places.
 */
function MoveHereDialog({
  orgId,
  folder,
  folders,
  team,
  onClose,
  onMoved,
}: {
  orgId: string;
  folder: Folder;
  folders: readonly Folder[];
  team: string | undefined;
  onClose: () => void;
  onMoved: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const searchId = useId();
  const [typed, setTyped] = useState("");
  const [query, setQuery] = useState("");
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(typed.trim()), SEARCH_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [typed]);
  const place = placeLabel(t, folders, folder.id);
  const candidates = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "moveHere", folder.id, query, team ?? null],
    queryFn: ({ signal }) =>
      fetchAnalyses(
        orgId,
        { q: query === "" ? undefined : query, team, sort: "updated", limit: 50 },
        signal,
      ),
    placeholderData: keepPreviousData,
  });
  const move = useMutation({
    mutationFn: async (analysis: Analysis) => {
      const full = await fetchAnalysis(orgId, analysis.id);
      if (full.model === undefined) {
        throw new Error("no model");
      }
      return saveAnalysis(orgId, analysis.id, {
        model: full.model,
        version: full.version,
        folderId: folder.id,
      });
    },
    onSuccess: async (saved) => {
      showToast({ message: t("analyses.list.moved", { title: saved.title, place }) });
      onClose();
      await onMoved();
    },
  });
  const items = (candidates.data?.items ?? []).filter(
    (item) => item.folderId !== folder.id && item.access.write,
  );
  let body: ReactNode;
  if (candidates.isPending) {
    body = <p className="loading">{t("common.loading")}</p>;
  } else if (candidates.isError) {
    body = <FormAlert>{errorMessage(t, candidates.error)}</FormAlert>;
  } else if (items.length === 0) {
    body = (
      <p className="data-table__muted">
        {candidates.data?.nextCursor == null
          ? t("analyses.moveHere.none")
          : t("analyses.moveHere.search")}
      </p>
    );
  } else {
    body = (
      <>
        {candidates.data?.nextCursor == null ? null : (
          <p className="data-table__muted">{t("analyses.moveHere.more")}</p>
        )}
        <ul className="analysis-move-here">
          {items.map((item) => (
            <li key={item.id} className="analysis-move-here__item">
              <span className="analysis-row__title">
                <span className="truncate" title={item.title}>
                  {item.title}
                </span>
                <span className="analysis-row__detail">
                  {placeLabel(t, folders, item.folderId)}
                </span>
              </span>
              <button
                type="button"
                className="button button--secondary button--small"
                disabled={move.isPending}
                aria-label={t("analyses.moveHere.moveNamed", { title: item.title })}
                onClick={() => move.mutate(item)}
              >
                {t("analyses.moveHere.move")}
              </button>
            </li>
          ))}
        </ul>
      </>
    );
  }
  return (
    <Dialog
      title={t("analyses.moveHere.title", { place })}
      onClose={onClose}
      actions={
        <button type="button" className="button button--secondary" onClick={onClose}>
          {t("analyses.dialog.close")}
        </button>
      }
    >
      <div className="field">
        <label className="visually-hidden" htmlFor={searchId}>
          {t("analyses.list.search")}
        </label>
        <input
          id={searchId}
          type="search"
          className="input"
          data-autofocus
          placeholder={t("analyses.list.searchPlaceholder")}
          value={typed}
          onChange={(event) => setTyped(event.currentTarget.value)}
        />
      </div>
      <FormAlert>{move.isError ? errorMessage(t, move.error) : null}</FormAlert>
      {body}
    </Dialog>
  );
}
