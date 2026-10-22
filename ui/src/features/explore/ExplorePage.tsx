import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import type { DocumentSet, Shape } from "../../api/generated/shapes";
import { BUSY_RETRY } from "../../api/retry";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Page } from "../../components/Page";
import { ProjectionEditor } from "../../documents/ProjectionEditor";
import {
  hasProjectionProblems,
  projectionFor,
  projectionPaths,
  storableTransformations,
  withProjection,
} from "../../documents/projection";
import { schemaOf } from "../../documents/schema";
import { useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { panelsForShapes, suggestPanel } from "../../panels/registry";
import type { PanelModel } from "../dashboards/model";
import { PanelBody } from "../dashboards/PanelCard";
import { appendPages, documentsOf, outcomesOf, projectOutcomes } from "../dashboards/results";
import { TimeRangePicker } from "../dashboards/TimeRangePicker";
import {
  intervalFor,
  MAX_DATA_POINTS,
  resolveRange,
  type TextRange,
} from "../dashboards/timeRange";
import { errorBodyMessage, errorMessage } from "../dashboards/ui/errors";
import { Inspect } from "../dashboards/ui/Inspect";
import { datasourcesQuery, kindsQuery, runQuery, sourceAccess } from "../datasources/api";
import { preloadCodeEditor } from "../datasources/editors/CodeEditor";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { addMatch, isMongoQuery, parseMongoQuery } from "../datasources/mongoQuery";
import { emptyQuery, queryText } from "../datasources/queryKinds";
import { AddToDashboardDialog } from "./AddToDashboardDialog";
import "./explore.css";

// Explore always shows a query editor; its editor starts loading with the page.
preloadCodeEditor();

const LAST_DATASOURCE_KEY = "kalzit.explore.datasource";
/** The single query of Explore; panels created from it keep this reference id. */
const REF_ID = "A";

interface Submitted {
  datasourceId: string;
  query: unknown;
  range: TextRange;
  /** Resolved when run, so the result and its axes belong to one moment. */
  from: number;
  to: number;
  run: number;
}

export function ExplorePage() {
  const { t } = useI18n();
  useDocumentTitle("explore.title");
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const orgWide = permissions.has("datasources:query");
  // Without the org-wide permission, a `query` grant on one source is enough for Explore.
  const sources = useQuery({
    ...datasourcesQuery(org?.id ?? ""),
    enabled: org !== undefined && permissions.loaded && !orgWide,
  });
  const granted = sources.data?.some((source) => source.access?.query === true) ?? false;
  let body = null;
  if (org !== undefined && (orgWide || granted)) {
    body = <Explore orgId={org.id} />;
  } else if (permissions.loaded && (org === undefined || !sources.isPending)) {
    body = (
      <EmptyState icon="lock" title={t("explore.forbidden.title")}>
        {t("explore.forbidden.text")}
      </EmptyState>
    );
  }
  return (
    <Page title={t("explore.title")} lead={t("explore.lead")}>
      {body}
    </Page>
  );
}

function Explore({ orgId }: { orgId: string }) {
  const { t } = useI18n();
  const permissions = useOrgPermissions();
  const datasourceId = useId();
  const datasources = useQuery(datasourcesQuery(orgId));
  const kinds = useQuery(kindsQuery(orgId));
  const [chosen, setChosen] = useState<string | null>(() => readPreference(LAST_DATASOURCE_KEY));
  const [queries, setQueries] = useState<Record<string, unknown>>({});
  // The projection step per data source; it belongs to the panel, not to the query.
  const [steps, setSteps] = useState<Record<string, unknown[]>>({});
  // Pages loaded after the first one through `nextCursor`, for the run they belong to.
  const [more, setMore] = useState<{
    of: Submitted | null;
    pages: DocumentSet[];
    loading: boolean;
    error: string | null;
  }>({ of: null, pages: [], loading: false, error: null });
  const [range, setRange] = useState<TextRange>({ from: "now-1h", to: "now" });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  // Per data source: whether its editor holds text that does not parse yet.
  const [pendingText, setPendingText] = useState<Record<string, boolean>>({});
  const [panelType, setPanelType] = useState<string | null>(null);
  const [tab, setTab] = useState<"result" | "inspect">("result");
  const [adding, setAdding] = useState(false);
  const tabsId = useId();

  // Only the sources the caller may query (the role or a grant).
  const list = (datasources.data ?? []).filter(
    (source) => sourceAccess(source.access, permissions).query,
  );
  const datasource = list.find((d) => d.id === chosen) ?? list[0];
  const query =
    datasource === undefined ? null : (queries[datasource.id] ?? emptyQuery(datasource.kind));

  const result = useQuery({
    queryKey: ["explore", orgId, submitted],
    enabled: submitted !== null,
    staleTime: Number.POSITIVE_INFINITY,
    ...BUSY_RETRY,
    queryFn: async ({ signal }) => {
      const run = submitted as Submitted;
      const timeRange = { from: run.from, to: run.to };
      const response = await runQuery(
        orgId,
        {
          queries: [{ refId: REF_ID, datasourceId: run.datasourceId, query: run.query }],
          timeRange,
          maxDataPoints: MAX_DATA_POINTS,
          intervalMs: intervalFor(timeRange),
          variables: {},
        },
        signal,
      );
      return outcomesOf(response, [REF_ID]);
    },
  });

  function run(nextRange = range, nextQuery: unknown = query) {
    if (datasource === undefined || nextQuery === null || queryText(nextQuery).trim() === "") {
      return;
    }
    // A new run leaves an old filter refusal behind.
    setFilterError(null);
    const resolved = resolveRange(nextRange, Date.now());
    if (!resolved.ok) {
      setRangeError(t(`dashboards.time.error.${resolved.error}`));
      return;
    }
    setRangeError(null);
    setSubmitted((current) => ({
      datasourceId: datasource.id,
      query: nextQuery,
      range: nextRange,
      ...resolved.range,
      run: (current?.run ?? 0) + 1,
    }));
  }

  if (datasources.isPending) {
    return <p className="loading">{t("common.loading")}</p>;
  }
  if (datasources.isError) {
    return <FormAlert>{errorMessage(t, datasources.error)}</FormAlert>;
  }
  if (datasource === undefined || query === null) {
    return (
      <EmptyState icon="dataSources" title={t("explore.noDatasources.title")}>
        {t("explore.noDatasources.text")}
      </EmptyState>
    );
  }

  const current = more.of === submitted ? more : { pages: [], loading: false, error: null };
  const outcomes = appendPages(result.data ?? [], REF_ID, current.pages);
  const nextCursor = documentsOf(outcomes)[0]?.documents.nextCursor;

  async function loadMore(cursor: string) {
    const run = submitted;
    if (run === null) {
      return;
    }
    setMore({ of: run, pages: current.pages, loading: true, error: null });
    const keep = (update: (pages: DocumentSet[]) => typeof more) =>
      setMore((state) => (state.of === run ? update(state.pages) : state));
    try {
      const timeRange = { from: run.from, to: run.to };
      const response = await runQuery(orgId, {
        queries: [{ refId: REF_ID, datasourceId: run.datasourceId, query: run.query, cursor }],
        timeRange,
        maxDataPoints: MAX_DATA_POINTS,
        intervalMs: intervalFor(timeRange),
        variables: {},
      });
      const [outcome] = outcomesOf(response, [REF_ID]);
      if (outcome !== undefined && "result" in outcome && outcome.result.shape === "documents") {
        const page = outcome.result.documents;
        keep((pages) => ({ of: run, pages: [...pages, page], loading: false, error: null }));
      } else {
        const message =
          outcome !== undefined && "error" in outcome
            ? errorBodyMessage(t, outcome.error)
            : t("documents.more.failed");
        keep((pages) => ({ of: run, pages, loading: false, error: message }));
      }
    } catch (problem) {
      keep((pages) => ({ of: run, pages, loading: false, error: errorMessage(t, problem) }));
    }
  }
  const projection = projectionFor(steps[datasource.id] ?? [], REF_ID);
  const transformations = submitted === null ? [] : (steps[submitted.datasourceId] ?? []);
  // The suggestion follows what the panel will get: documents, or the frame of a projection step.
  const results = projectOutcomes(outcomes, transformations).flatMap((o) =>
    "result" in o ? [o.result] : [],
  );
  const kindShapes = kinds.data?.find((k) => k.kind === datasource.kind)?.shapes ?? ["frame"];
  const takesDocuments = kindShapes.includes("documents");
  const shapes: Shape[] =
    projection === undefined || projection.disabled === true
      ? kindShapes
      : [...new Set<Shape>([...kindShapes, "frame"])];
  // Paths to suggest for the projection: those of the last result's documents.
  const resultFields = documentsOf(outcomes).flatMap(({ documents }) =>
    projectionPaths(schemaOf(documents)),
  );
  const choices = panelsForShapes(shapes);
  const type = panelType ?? (results.length > 0 ? suggestPanel(results) : "table");
  const panel: PanelModel = {
    id: "explore",
    type,
    title: "",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets:
      submitted === null
        ? []
        : [{ refId: REF_ID, datasourceId: submitted.datasourceId, query: submitted.query }],
    transformations,
    options: {},
    fieldConfig: {},
  };

  return (
    <div className="explore">
      <div className="explore__toolbar">
        <div className="preference">
          <label htmlFor={datasourceId}>{t("explore.datasource")}</label>
          <select
            id={datasourceId}
            className="select"
            value={datasource.id}
            onChange={(event) => {
              setChosen(event.currentTarget.value);
              setFilterError(null);
              writePreference(LAST_DATASOURCE_KEY, event.currentTarget.value);
            }}
          >
            {list.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name}
              </option>
            ))}
          </select>
        </div>
        <TimeRangePicker
          value={range}
          onChange={(next) => {
            setRange(next);
            if (submitted !== null) {
              run(next);
            }
          }}
        />
        <button
          type="button"
          className="button button--primary"
          onClick={() => run()}
          disabled={queryText(query).trim() === ""}
        >
          {result.isFetching ? t("explore.running") : t("explore.run")}
        </button>
      </div>
      {rangeError === null ? null : <FormAlert>{rangeError}</FormAlert>}
      {filterError === null ? null : <FormAlert>{filterError}</FormAlert>}
      <QueryEditor
        key={datasource.id}
        orgId={orgId}
        datasource={datasource}
        query={query}
        onChange={(next) => setQueries((current) => ({ ...current, [datasource.id]: next }))}
        onRun={() => run()}
        onPendingText={(pending) =>
          setPendingText((current) =>
            current[datasource.id] === pending ? current : { ...current, [datasource.id]: pending },
          )
        }
        previewRun={() => {
          // Previews run over the range Explore shows, resolved when asked; Explore has no variables.
          const resolved = resolveRange(range, Date.now());
          const now = Date.now();
          return {
            range: resolved.ok ? resolved.range : { from: now - 3_600_000, to: now },
            variables: {},
          };
        }}
      />
      {takesDocuments ? (
        <ProjectionEditor
          projection={projection}
          fields={[...new Set(resultFields)]}
          onChange={(next) =>
            setSteps((all) => ({
              ...all,
              [datasource.id]: withProjection(all[datasource.id] ?? [], REF_ID, next),
            }))
          }
        />
      ) : null}
      {submitted === null ? (
        <p className="explore__hint">{t("explore.hint")}</p>
      ) : (
        <section
          className="explore__result"
          aria-label={t("explore.result")}
          aria-busy={result.isFetching}
        >
          <div className="explore__result-bar">
            <Tabs idPrefix={tabsId} tab={tab} onTab={setTab} />
            <div className="preference">
              <label htmlFor={`${datasourceId}-panel`}>{t("explore.visualization")}</label>
              <select
                id={`${datasourceId}-panel`}
                className="select"
                value={type}
                onChange={(event) => setPanelType(event.currentTarget.value)}
              >
                {choices.map(({ panel: choice }) => (
                  <option key={choice.type} value={choice.type}>
                    {t(choice.name)}
                  </option>
                ))}
              </select>
            </div>
            {permissions.has("dashboards:write") ? (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setAdding(true)}
                disabled={result.data === undefined || hasProjectionProblems(transformations)}
              >
                {t("explore.addToDashboard")}
              </button>
            ) : null}
          </div>
          {/* Both panels exist, so every tab's aria-controls points at an element. */}
          <div
            className="explore__panel"
            role="tabpanel"
            id={`${tabsId}-result`}
            aria-labelledby={`${tabsId}-result-tab`}
            hidden={tab !== "result"}
          >
            {tab === "result" ? (
              <PanelBody
                panel={panel}
                title={t("explore.result")}
                range={{ from: submitted.from, to: submitted.to }}
                pending={result.isPending}
                error={result.error}
                outcomes={outcomes}
                revision={`${submitted.run}:${current.pages.length}`}
                onFilter={
                  isMongoQuery(submitted.query) && submitted.datasourceId === datasource.id
                    ? (_refId, path, value) => {
                        // The filter joins the query in the editor (the one that gave this
                        // result, or the draft typed since) as a visible $match stage, and runs.
                        // Text that does not parse, in the query or still in a field, is never
                        // replaced: the filter waits for it.
                        if (pendingText[datasource.id] === true) {
                          setFilterError(t("documents.filter.refused.draft"));
                          return;
                        }
                        const added = addMatch(parseMongoQuery(query), path, value);
                        if ("refused" in added) {
                          setFilterError(t(`documents.filter.refused.${added.refused}`));
                          return;
                        }
                        setFilterError(null);
                        setQueries((current) => ({ ...current, [datasource.id]: added.query }));
                        run(range, added.query);
                      }
                    : undefined
                }
              />
            ) : null}
          </div>
          <div
            className="explore__panel"
            role="tabpanel"
            id={`${tabsId}-inspect`}
            aria-labelledby={`${tabsId}-inspect-tab`}
            hidden={tab !== "inspect"}
          >
            {tab === "inspect" ? <Inspect outcomes={outcomes} /> : null}
          </div>
          {nextCursor === undefined ? null : (
            <div className="explore__more">
              <button
                type="button"
                className="button button--secondary"
                disabled={current.loading}
                onClick={() => void loadMore(nextCursor)}
              >
                {current.loading ? t("common.loading") : t("documents.more.load")}
              </button>
            </div>
          )}
          {current.error === null ? null : <FormAlert>{current.error}</FormAlert>}
        </section>
      )}
      {adding && submitted !== null ? (
        <AddToDashboardDialog
          orgId={orgId}
          panel={{
            ...panel,
            title: datasource.name,
            transformations: storableTransformations(transformations),
          }}
          range={submitted.range}
          onClose={() => setAdding(false)}
        />
      ) : null}
    </div>
  );
}

const TABS = ["result", "inspect"] as const;

/** Result and inspector tabs; Left and Right switch, as in the WAI-ARIA tabs pattern. */
function Tabs({
  idPrefix,
  tab,
  onTab,
}: {
  idPrefix: string;
  tab: (typeof TABS)[number];
  onTab: (tab: (typeof TABS)[number]) => void;
}) {
  const { t } = useI18n();
  const listRef = useRef<HTMLDivElement>(null);
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const index = TABS.indexOf(tab);
    const next =
      TABS[(index + (event.key === "ArrowRight" ? 1 : TABS.length - 1)) % TABS.length] ?? "result";
    onTab(next);
    document.getElementById(`${idPrefix}-${next}-tab`)?.focus();
  }
  return (
    <div
      className="tabs"
      role="tablist"
      aria-label={t("explore.result")}
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {TABS.map((name) => (
        <button
          key={name}
          type="button"
          role="tab"
          id={`${idPrefix}-${name}-tab`}
          className="tabs__tab"
          aria-selected={tab === name}
          aria-controls={`${idPrefix}-${name}`}
          tabIndex={tab === name ? 0 : -1}
          onClick={() => onTab(name)}
        >
          {t(`explore.tab.${name}`)}
        </button>
      ))}
    </div>
  );
}
