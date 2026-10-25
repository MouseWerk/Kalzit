import {
  type QueryObserverResult,
  useInfiniteQuery,
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { IconButton } from "../../components/IconButton";
import { Page, PageActions } from "../../components/Page";
import { STACK_ROLES } from "../../components/stackTable";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { zoneOption } from "../../lib/timeSettings";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { errorMessage } from "../dashboards/ui/errors";
import {
  DATASOURCES_KEY,
  type DatasourceSummary,
  fetchDatasourcePage,
  type Health,
  kindsQuery,
  restoreDatasource,
  sourceAccess,
} from "./api";
import { DataSourceDrawer } from "./DataSourceDrawer";
import { KindLabel, KindMark } from "./kindMarks";
import { StatusLabel } from "./StatusLabel";
import {
  filterSources,
  forgetHealth,
  type HealthEntry,
  healthEntry,
  healthQuery,
  isFiltered,
  KIND_GROUPS,
  type KindGroup,
  kindGroup,
  type ListFilter,
  median,
  NO_FILTER,
  needsAllPages,
  runHealthCheck,
  runHealthChecks,
  SORTS,
  type SourceStatus,
  STATUS_FILTERS,
  statusOf,
  testableIds,
} from "./sourceStatus";
import "./datasources.css";

const listRoute = getRouteApi("/_app/data-sources");

export function DataSourcesPage() {
  const { t } = useI18n();
  useDocumentTitle("datasources.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const { trash } = listRoute.useSearch();
  let body = null;
  if (org === undefined) {
    body = (
      <EmptyState icon="dataSources" title={t("datasources.noOrg.title")}>
        {t("datasources.noOrg.text")}
      </EmptyState>
    );
  } else {
    // Every member may ask: the list holds the sources the caller may read or query, and the
    // trash those they may restore, through the role or a grant on the source.
    body = (
      <DataSourceList
        key={trash === true ? "trash" : "list"}
        orgId={org.id}
        trash={trash === true}
        canCreate={permissions.has("datasources:write")}
      />
    );
  }
  return (
    <Page
      title={trash === true ? t("datasources.trash.title") : t("datasources.title")}
      lead={trash === true ? t("datasources.trash.lead") : t("datasources.lead")}
    >
      {body}
    </Page>
  );
}

function DataSourceList({
  orgId,
  trash,
  canCreate,
}: {
  orgId: string;
  trash: boolean;
  /** Adding a source needs the org-wide `datasources:write`; a grant is always on one source. */
  canCreate: boolean;
}) {
  const { t, language, timeZone } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const list = useInfiniteQuery({
    queryKey: [DATASOURCES_KEY, orgId, trash ? "trash" : "list"],
    queryFn: ({ pageParam, signal }) =>
      fetchDatasourcePage(orgId, { cursor: pageParam, trash }, signal),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
  });
  const kinds = useQuery(kindsQuery(orgId));
  // Every kind the server offers (its registry), for the empty list's text.
  const names = (kinds.isSuccess ? kinds.data : []).map((kind) => kind.name);
  const restore = useMutation({
    mutationFn: (id: string) => restoreDatasource(orgId, id),
    onSuccess: async (_, id) => {
      forgetHealth(queryClient, orgId, id);
      await queryClient.invalidateQueries({ queryKey: [DATASOURCES_KEY, orgId] });
    },
  });
  const kindName = (kind: string) => kinds.data?.find((k) => k.kind === kind)?.name ?? kind;
  const items = list.data?.pages.flatMap((page) => page.items) ?? [];
  const accessOf = (source: DatasourceSummary) => sourceAccess(source.access, permissions);
  // The trash lists what the caller may restore: offer it to those who may change a source.
  const canSeeTrash = canCreate || items.some((source) => accessOf(source).write);
  const dateFormat = new Intl.DateTimeFormat(language, {
    dateStyle: "medium",
    ...zoneOption(timeZone),
  });

  const toolbar = trash ? (
    <div className="toolbar">
      <Link to="/data-sources" search={{}} className="back-link">
        <Icon name="back" />
        {t("datasources.trash.back")}
      </Link>
    </div>
  ) : canCreate || canSeeTrash ? (
    <div className="toolbar">
      {/* The main action last, on the right, as on the blueprint. */}
      <Link to="/data-sources" search={{ trash: true }} className="button button--ghost">
        <Icon name="trash" />
        {t("datasources.trash.link")}
      </Link>
      {canCreate ? (
        <Link to="/data-sources/new" search={{}} className="button button--primary">
          <Icon name="plus" />
          {t("datasources.add")}
        </Link>
      ) : null}
    </div>
  ) : null;

  if (list.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (list.isError) {
    return <FormAlert>{errorMessage(t, list.error)}</FormAlert>;
  }
  if (items.length === 0) {
    return (
      <>
        <PageActions>{toolbar}</PageActions>
        {trash ? (
          <EmptyState icon="dataSources" title={t("datasources.trash.empty")}>
            {t("datasources.trash.emptyText")}
          </EmptyState>
        ) : (
          <EmptyState icon="dataSources" title={t("datasources.empty.title")}>
            {!canCreate
              ? t("datasources.empty.textReadOnly")
              : names.length === 0
                ? t("datasources.empty.text")
                : t("datasources.empty.textKinds", {
                    kinds: new Intl.ListFormat(language, { type: "conjunction" }).format(names),
                  })}
          </EmptyState>
        )}
      </>
    );
  }
  const more = list.hasNextPage ? (
    <button
      type="button"
      className="button button--secondary ds-list__more"
      onClick={() => void list.fetchNextPage()}
      disabled={list.isFetchingNextPage}
    >
      {t("datasources.loadMore")}
    </button>
  ) : null;
  if (trash) {
    return (
      <div className="ds-list">
        <FormAlert>{restore.isError ? errorMessage(t, restore.error) : null}</FormAlert>
        <PageActions>{toolbar}</PageActions>
        <TrashTable
          items={items}
          kindName={kindName}
          date={(source) => dateFormat.format(source.deletedAt ?? 0)}
          onRestore={(id) => restore.mutate(id)}
        />
        {more}
      </div>
    );
  }
  return (
    <div className="ds-list">
      <PageActions>{toolbar}</PageActions>
      <SourceOverview
        orgId={orgId}
        items={items}
        kindName={kindName}
        shapesOf={(kind) => kinds.data?.find((k) => k.kind === kind)?.shapes ?? []}
        added={(source) => dateFormat.format(source.createdAt)}
        more={more}
        partial={list.hasNextPage}
        loadingMore={list.isFetchingNextPage}
        onNeedAll={() => {
          if (list.hasNextPage && !list.isFetchingNextPage) {
            void list.fetchNextPage();
          }
        }}
      />
    </div>
  );
}

/** The trash: name, kind, when it was deleted, and restore. */
function TrashTable({
  items,
  kindName,
  date,
  onRestore,
}: {
  items: readonly DatasourceSummary[];
  kindName: (kind: string) => string;
  date: (source: DatasourceSummary) => string;
  onRestore: (id: string) => void;
}) {
  const { t } = useI18n();
  const dateLabel = t("datasources.column.deleted");
  return (
    <table className="data-table data-table--stack" {...STACK_ROLES.table}>
      <thead {...STACK_ROLES.rowgroup}>
        <tr {...STACK_ROLES.row}>
          <th scope="col" {...STACK_ROLES.columnheader}>
            {t("datasources.column.name")}
          </th>
          <th scope="col" {...STACK_ROLES.columnheader}>
            {t("datasources.column.kind")}
          </th>
          <th scope="col" {...STACK_ROLES.columnheader}>
            {dateLabel}
          </th>
          <th scope="col" {...STACK_ROLES.columnheader}>
            <span className="visually-hidden">{t("datasources.column.actions")}</span>
          </th>
        </tr>
      </thead>
      <tbody {...STACK_ROLES.rowgroup}>
        {items.map((source) => (
          <tr key={source.id} {...STACK_ROLES.row}>
            <td {...STACK_ROLES.cell}>{source.name}</td>
            <td {...STACK_ROLES.cell} data-label={t("datasources.column.kind")}>
              <KindLabel kind={source.kind} name={kindName(source.kind)} />
            </td>
            <td {...STACK_ROLES.cell} data-label={dateLabel}>
              {date(source)}
            </td>
            <td {...STACK_ROLES.cell} className="data-table__actions">
              <button
                type="button"
                className="button button--secondary button--small"
                onClick={() => onRestore(source.id)}
                aria-label={t("datasources.restoreNamed", { name: source.name })}
              >
                {t("datasources.restore")}
              </button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * The list as on the blueprint: status tiles, search and filters, the table with each source's
 * status and latency, and a side panel for the selected source. Status comes from connection
 * tests run on request (one row, the panel, or all at once); the server keeps no history yet.
 */
function SourceOverview({
  orgId,
  items,
  kindName,
  shapesOf,
  added,
  more,
  partial,
  loadingMore,
  onNeedAll,
}: {
  orgId: string;
  items: readonly DatasourceSummary[];
  kindName: (kind: string) => string;
  shapesOf: (kind: string) => readonly ("frame" | "documents" | "graph")[];
  added: (source: DatasourceSummary) => string;
  more: ReactNode;
  /** More pages exist: counts and filters cover the loaded rows only. */
  partial: boolean;
  loadingMore: boolean;
  /** Loads the next page; called while a filter or sort needs every source. */
  onNeedAll: () => void;
}) {
  const { t, language } = useI18n();
  const permissions = useOrgPermissions();
  const queryClient = useQueryClient();
  const ids = { search: useId(), status: useId(), sort: useId(), drawer: useId() };
  const [filter, setFilter] = useState<ListFilter>(NO_FILTER);
  const [selected, setSelected] = useState<string | null>(null);
  const [testingAll, setTestingAll] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const drawerHeading = useRef<HTMLDivElement>(null);
  const detailButtons = useRef(new Map<string, HTMLButtonElement>());
  // Aborted when the page is left: "Test all" starts no further tests then.
  const leaving = useRef<AbortController | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    leaving.current = controller;
    return () => controller.abort();
  }, []);

  // A filter or a sort over a partly loaded list would leave out or misplace the rest: load
  // every page while one is set, a page at a time.
  const wantAll = needsAllPages(filter);
  useEffect(() => {
    if (wantAll && partial && !loadingMore) {
      onNeedAll();
    }
  }, [wantAll, partial, loadingMore, onNeedAll]);

  const combine = useCallback(
    (results: readonly QueryObserverResult<Health, Error>[]) =>
      new Map(
        results.map((result, index): [string, HealthEntry | undefined] => [
          items[index]?.id ?? "",
          healthEntry(result),
        ]),
      ),
    [items],
  );
  const entries = useQueries({
    queries: items.map((source) => healthQuery(orgId, source.id)),
    combine,
  });
  const statusById = (id: string): SourceStatus => statusOf(entries.get(id));
  const accessOf = (source: DatasourceSummary) => sourceAccess(source.access, permissions);
  const testable = testableIds(items, accessOf);
  const rows = filterSources(items, filter, kindName, statusById, language);
  const current = items.find((source) => source.id === selected);

  async function testAll() {
    const signal = leaving.current?.signal;
    setTestingAll(true);
    setAnnouncement("");
    await runHealthChecks(queryClient, orgId, testable, signal === undefined ? {} : { signal });
    if (signal?.aborted === true) {
      return;
    }
    setTestingAll(false);
    setAnnouncement(t("datasources.testAll.done", { count: testable.length }));
  }

  /** One test; its outcome goes to the page's one live region. */
  async function testOne(source: DatasourceSummary) {
    setAnnouncement("");
    await runHealthCheck(queryClient, orgId, source.id);
    const state = queryClient.getQueryState(healthQuery(orgId, source.id).queryKey);
    if (state === undefined || leaving.current?.signal.aborted === true) {
      return;
    }
    const status = statusOf(healthEntry(state));
    setAnnouncement(
      t("datasources.testOne.done", {
        name: source.name,
        status: t(`datasources.status.${status}`),
      }),
    );
  }

  function select(id: string) {
    setSelected(id);
    // The panel follows the table (below it on narrow screens): bring the reader along.
    requestAnimationFrame(() => {
      const panel = drawerHeading.current;
      // Not when the reader already moved on into the panel (a tab clicked before this frame).
      if (panel !== null && !panel.contains(document.activeElement)) {
        panel.querySelector("h2")?.focus();
      }
    });
  }

  function close() {
    const id = selected;
    setSelected(null);
    if (id !== null) {
      requestAnimationFrame(() => detailButtons.current.get(id)?.focus());
    }
  }

  function onRowClick(event: MouseEvent<HTMLTableRowElement>, id: string) {
    // Links and buttons in the row do their own thing.
    if ((event.target as HTMLElement).closest("a, button") !== null) {
      return;
    }
    select(id);
  }

  const groupCounts = new Map<KindGroup, number>();
  for (const source of items) {
    const group = kindGroup(source.kind);
    groupCounts.set(group, (groupCounts.get(group) ?? 0) + 1);
  }

  return (
    <>
      <StatusTiles
        items={items}
        statusById={statusById}
        entries={entries}
        partial={partial}
        status={filter.status}
        onStatus={(status) =>
          setFilter((prev) => ({ ...prev, status: prev.status === status ? "all" : status }))
        }
      />
      <div className="ds-filters">
        <div className="ds-filters__row">
          <div className="ds-search">
            <Icon name="search" />
            <label className="visually-hidden" htmlFor={ids.search}>
              {t("datasources.search")}
            </label>
            <input
              id={ids.search}
              type="search"
              className="input ds-search__input"
              placeholder={t("datasources.search")}
              value={filter.search}
              onChange={(event) => {
                const search = event.currentTarget.value;
                setFilter((prev) => ({ ...prev, search }));
              }}
            />
          </div>
          <div className="ds-picker">
            <label className="ds-picker__label" htmlFor={ids.status}>
              {t("datasources.filter.status")}
            </label>
            <select
              id={ids.status}
              className="select ds-picker__select"
              value={filter.status}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const status = STATUS_FILTERS.find((candidate) => candidate === value) ?? "all";
                setFilter((prev) => ({ ...prev, status }));
              }}
            >
              <option value="all">{t("datasources.filter.all")}</option>
              {STATUS_FILTERS.map((status) => (
                <option key={status} value={status}>
                  {t(`datasources.status.${status}`)}
                </option>
              ))}
            </select>
          </div>
          <div className="ds-picker">
            <label className="ds-picker__label" htmlFor={ids.sort}>
              {t("datasources.sort.label")}
            </label>
            <select
              id={ids.sort}
              className="select ds-picker__select"
              value={filter.sort}
              onChange={(event) => {
                const value = event.currentTarget.value;
                const sort = SORTS.find((candidate) => candidate === value) ?? "name";
                setFilter((prev) => ({ ...prev, sort }));
              }}
            >
              {SORTS.map((sort) => (
                <option key={sort} value={sort}>
                  {t(`datasources.sort.${sort}`)}
                </option>
              ))}
            </select>
          </div>
          {testable.length > 0 ? (
            <button
              type="button"
              className="button button--secondary ds-filters__test"
              onClick={() => void testAll()}
              disabled={testingAll}
            >
              <Icon name="refresh" />
              {testingAll ? t("datasources.health.testing") : t("datasources.testAll.label")}
            </button>
          ) : null}
        </div>
        <div className="ds-filters__row">
          <fieldset className="ds-groups">
            <legend className="visually-hidden">{t("datasources.column.kind")}</legend>
            {(["all", ...KIND_GROUPS] as const)
              .filter((group) => group === "all" || (groupCounts.get(group) ?? 0) > 0)
              .map((group) => (
                <button
                  key={group}
                  type="button"
                  className="ds-groups__button"
                  aria-pressed={filter.group === group}
                  onClick={() => setFilter((prev) => ({ ...prev, group }))}
                >
                  {t(`datasources.group.${group}`)}
                  <span className="ds-groups__count">
                    {group === "all" ? items.length : groupCounts.get(group)}
                  </span>
                </button>
              ))}
          </fieldset>
          <p className="ds-filters__count">
            <span>
              {t("datasources.filter.shown", {
                shown: rows.length,
                total: partial
                  ? t("datasources.tiles.atLeast", { count: items.length })
                  : items.length,
              })}
            </span>
            {isFiltered(filter) ? (
              <button
                type="button"
                className="button button--ghost button--small"
                onClick={() => setFilter((prev) => ({ ...NO_FILTER, sort: prev.sort }))}
              >
                {t("datasources.filter.reset")}
              </button>
            ) : null}
          </p>
        </div>
      </div>
      <p className="visually-hidden" role="status">
        {announcement}
      </p>
      <div className={current === undefined ? "ds-layout" : "ds-layout ds-layout--drawer"}>
        <div className="ds-layout__main">
          {rows.length === 0 ? (
            <EmptyState icon="search" title={t("datasources.filter.none")}>
              {partial ? t("datasources.filter.noneLoading") : t("datasources.filter.noneText")}
            </EmptyState>
          ) : (
            <table className="data-table data-table--stack ds-table" {...STACK_ROLES.table}>
              <thead {...STACK_ROLES.rowgroup}>
                <tr {...STACK_ROLES.row}>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("datasources.column.name")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("datasources.column.kind")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("datasources.column.status")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    {t("datasources.column.created")}
                  </th>
                  <th scope="col" {...STACK_ROLES.columnheader}>
                    <span className="visually-hidden">{t("datasources.column.actions")}</span>
                  </th>
                </tr>
              </thead>
              <tbody {...STACK_ROLES.rowgroup}>
                {rows.map((source) => {
                  const access = accessOf(source);
                  const entry = entries.get(source.id);
                  const isSelected = source.id === selected;
                  return (
                    <tr
                      key={source.id}
                      {...STACK_ROLES.row}
                      aria-selected={isSelected}
                      onClick={(event) => onRowClick(event, source.id)}
                    >
                      <td {...STACK_ROLES.cell}>
                        <span className="ds-table__name">
                          <KindMark kind={source.kind} small />
                          {access.write ? (
                            <Link
                              to="/data-sources/$datasourceId"
                              params={{ datasourceId: source.id }}
                            >
                              {source.name}
                            </Link>
                          ) : (
                            <span>{source.name}</span>
                          )}
                        </span>
                      </td>
                      <td {...STACK_ROLES.cell} data-label={t("datasources.column.kind")}>
                        <span className="ds-table__kind">
                          <span>{kindName(source.kind)}</span>
                          <span className="ds-tag">
                            {t(`datasources.tag.${kindGroup(source.kind)}`)}
                          </span>
                        </span>
                      </td>
                      <td {...STACK_ROLES.cell} data-label={t("datasources.column.status")}>
                        {access.query ? (
                          <StatusLabel
                            status={statusById(source.id)}
                            latencyMs={entry?.health?.latencyMs}
                          />
                        ) : (
                          <span className="data-table__muted">
                            {t("datasources.status.noQuery")}
                          </span>
                        )}
                      </td>
                      <td
                        {...STACK_ROLES.cell}
                        className="ds-table__date"
                        data-label={t("datasources.column.created")}
                      >
                        {added(source)}
                      </td>
                      <td {...STACK_ROLES.cell} className="data-table__actions">
                        {/* Icons only: the status column already shows the outcome. */}
                        {access.query ? (
                          <IconButton
                            icon="refresh"
                            label={t("datasources.health.testNamed", { name: source.name })}
                            onClick={() => void testOne(source)}
                            disabled={entry?.pending === true}
                          />
                        ) : null}
                        <IconButton
                          icon="chevron"
                          label={t("datasources.detailsNamed", { name: source.name })}
                          className="ds-table__details"
                          aria-expanded={isSelected}
                          aria-controls={isSelected ? ids.drawer : undefined}
                          ref={(button) => {
                            if (button === null) {
                              detailButtons.current.delete(source.id);
                            } else {
                              detailButtons.current.set(source.id, button);
                            }
                          }}
                          onClick={() => (isSelected ? close() : select(source.id))}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {more}
        </div>
        {current === undefined ? null : (
          // biome-ignore lint/a11y/noStaticElementInteractions: Escape closes the panel; the controls inside take the keys
          <div
            id={ids.drawer}
            ref={drawerHeading}
            className="ds-layout__drawer"
            onKeyDown={(event) => {
              if (event.key === "Escape" && !isComposingKey(event)) {
                event.stopPropagation();
                close();
              }
            }}
          >
            <DataSourceDrawer
              key={current.id}
              orgId={orgId}
              source={current}
              kindName={kindName(current.kind)}
              shapes={shapesOf(current.kind)}
              added={added(current)}
              access={accessOf(current)}
              entry={entries.get(current.id)}
              onTest={() => void testOne(current)}
              onClose={close}
            />
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Four tiles over the list: how many sources, and how many answered, answered slowly or failed
 * in the last tests. The status tiles also filter the list by their status.
 */
function StatusTiles({
  items,
  statusById,
  entries,
  partial,
  status,
  onStatus,
}: {
  items: readonly DatasourceSummary[];
  statusById: (id: string) => SourceStatus;
  entries: ReadonlyMap<string, HealthEntry | undefined>;
  partial: boolean;
  status: ListFilter["status"];
  onStatus: (status: "connected" | "slow" | "unreachable") => void;
}) {
  const { t } = useI18n();
  const kindCount = new Set(items.map((source) => source.kind)).size;
  const of = (wanted: SourceStatus) => items.filter((source) => statusById(source.id) === wanted);
  const connected = of("connected");
  const slow = of("slow");
  const unreachable = of("unreachable");
  const tested = items.filter(
    (source) => !["untested", "testing"].includes(statusById(source.id)),
  ).length;
  const latency = (source: DatasourceSummary) => entries.get(source.id)?.health?.latencyMs ?? 0;
  const middle = median([...connected, ...slow].map(latency));
  const firstSlow = slow[0];
  const firstDown = unreachable[0];
  const untested = t("datasources.tiles.untested");

  const tiles = [
    {
      status: "connected" as const,
      count: connected.length,
      note: middle === null ? untested : t("datasources.tiles.median", { ms: Math.round(middle) }),
    },
    {
      status: "slow" as const,
      count: slow.length,
      note:
        firstSlow === undefined
          ? tested === 0
            ? untested
            : t("datasources.tiles.slowNone")
          : t("datasources.tiles.slowFirst", {
              name: firstSlow.name,
              ms: Math.round(latency(firstSlow)),
            }),
    },
    {
      status: "unreachable" as const,
      count: unreachable.length,
      note:
        firstDown === undefined
          ? tested === 0
            ? untested
            : t("datasources.tiles.downNone")
          : firstDown.name,
    },
  ];

  return (
    <section className="ds-tiles" aria-label={t("datasources.tiles.label")}>
      <div className="ds-tile">
        <span className="ds-tile__label">{t("datasources.tiles.sources")}</span>
        <span className="ds-tile__value">
          {partial ? t("datasources.tiles.atLeast", { count: items.length }) : items.length}
        </span>
        <span className="ds-tile__note">
          {kindCount === 1
            ? t("datasources.tiles.kindOne", { count: kindCount })
            : t("datasources.tiles.kindMany", { count: kindCount })}
        </span>
      </div>
      {tiles.map((tile) => (
        <button
          key={tile.status}
          type="button"
          className="ds-tile ds-tile--button"
          aria-pressed={status === tile.status}
          onClick={() => onStatus(tile.status)}
        >
          <span className="ds-tile__label">
            <span className="ds-status" data-status={tile.status}>
              <span className="ds-status__dot" aria-hidden="true" />
              <span>{t(`datasources.status.${tile.status}`)}</span>
            </span>
          </span>
          <span className="ds-tile__value">{tested === 0 ? "–" : tile.count}</span>
          <span className="ds-tile__note">{tile.note}</span>
        </button>
      ))}
    </section>
  );
}
