import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { getRouteApi, Link, useNavigate } from "@tanstack/react-router";
import {
  type KeyboardEvent,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
} from "react";
import { exportQuery } from "../../analysis/api";
import { ExportDialog } from "../../analysis/ExportDialog";
import {
  graphStepsByQuery,
  namedInputs,
  runPanelSteps,
  useAnalysisCalendar,
} from "../../analysis/panel";
import { StepsEditor } from "../../analysis/StepsEditor";
import { asSteps, type Step } from "../../analysis/steps";
import type { DocumentSet, QueryResult, Shape } from "../../api/generated/shapes";
import { dropOlderResults, RESULT_GC_MS } from "../../api/resultCache";
import { BUSY_RETRY } from "../../api/retry";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { Skeleton } from "../../components/Skeleton";
import { ProjectionEditor } from "../../documents/ProjectionEditor";
import {
  hasProjectionProblems,
  projectionApplies,
  projectionFor,
  projectionPaths,
  storableTransformations,
  withProjection,
} from "../../documents/projection";
import { schemaOf } from "../../documents/schema";
import { useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
import { tabForKey } from "../../lib/tabKeys";
import { showErrorToast, showToast } from "../../lib/toasts";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useSettled } from "../../lib/useSettled";
import { type LiveSpec, liveClient } from "../../live/client";
import { liveNote } from "../../live/text";
import { useLiveSubscription } from "../../live/useLive";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { PanelHostContext } from "../../panels/host";
import { panelsForShapes, suggestPanel } from "../../panels/registry";
import { AiGate } from "../ai/AiGate";
import { ExploreAiTools, useExploreAiSummary } from "../ai/ExploreAi";
import {
  ANALYSES_KEY,
  ANALYSIS_SCHEMA_VERSION,
  type Analysis,
  type AnalysisModel,
  analysisFromConflict,
  analysisQuery,
  createAnalysis,
  fetchVersions,
  saveAnalysis,
} from "../analyses/api";
import { ConflictDialog, ConflictNotice, type NewerVersion } from "../analyses/Conflict";
import { SaveControls, SavedAgo, SavedHeading, SaveShortcuts } from "../analyses/ExploreSaved";
import { OpenDialog } from "../analyses/OpenDialog";
import { placeGroups, placeLabel } from "../analyses/places";
import { SaveAnalysisDialog, type SaveMode, type SaveValues } from "../analyses/SaveAnalysisDialog";
import { visualizationName } from "../analyses/visualization";
import { foldersQuery } from "../dashboards/api";
import type { PanelModel } from "../dashboards/model";
import { PanelBody } from "../dashboards/PanelCard";
import { appendPages, documentsOf, outcomesOf } from "../dashboards/results";
import { rangeLabel, TimeRangePicker } from "../dashboards/TimeRangePicker";
import {
  intervalFor,
  MAX_DATA_POINTS,
  resolveRange,
  type TextRange,
} from "../dashboards/timeRange";
import { ConfirmDialog } from "../dashboards/ui/Dialog";
import { errorBodyMessage, errorMessage } from "../dashboards/ui/errors";
import { Inspect } from "../dashboards/ui/Inspect";
import { useLeaveGuard } from "../dashboards/ui/useLeaveGuard";
import { writeLiveResult } from "../dashboards/usePanelLive";
import {
  type DatasourceSummary,
  datasourcesQuery,
  fetchDistribution,
  kindsQuery,
  runQuery,
  sourceAccess,
} from "../datasources/api";
import { preloadCodeEditor } from "../datasources/editors/CodeEditor";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { addMatch, isMongoQuery, parseMongoQuery } from "../datasources/mongoQuery";
import { emptyQuery, familyOf, hasQuery, normalizeQuery } from "../datasources/queryKinds";
import { AddToDashboardDialog } from "./AddToDashboardDialog";
import { HistoryPanel } from "./HistoryPanel";
import { clearExploreHandoff, peekExploreHandoff } from "./handoff";
import { HISTORY_KEY, type HistoryEntry } from "./history";
import { LAST_DATASOURCE_KEY } from "./lastSource";
import "./explore.css";

// Explore always shows a query editor; its editor starts loading with the page.
preloadCodeEditor();

/** The single query of Explore; panels created from it keep this reference id. */
const REF_ID = "A";
/** The cache key of Explore runs: `[EXPLORE_KEY, orgId, submitted]`. */
const EXPLORE_KEY = "explore";
/** The cache key of the runs with graph steps (a key of their own, so a new run keeps them). */
const EXPLORE_STEPS_KEY = "explore-steps";
/** How long graph steps stay unchanged before they run in the database. */
const GRAPH_STEPS_SETTLE_MS = 600;

const exploreRoute = getRouteApi("/_app/explore");
const appRoute = getRouteApi("/_app");

/** The saved analysis open in Explore, as last loaded or saved. */
interface SavedState {
  analysis: Analysis & { model: AnalysisModel };
  /**
   * The editor's queries, steps, look and kept range when it last matched the saved version;
   * worked out on the first render after loading. "Changed" compares against it.
   */
  baseline: string | null;
  /** When it was opened, for the conflict dialog. */
  openedAt: number;
}

/** What "Changed" compares: everything but the name and description, which save on their own. */
function editedPart(model: AnalysisModel): string {
  return JSON.stringify([model.timeRange, model.targets, model.steps, model.visualization]);
}

function withModel(analysis: Analysis): (Analysis & { model: AnalysisModel }) | null {
  return analysis.model === undefined ? null : { ...analysis, model: analysis.model };
}

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
  const { analysis, source: startSource } = exploreRoute.useSearch();
  if (org !== undefined && (orgWide || granted)) {
    body = <Explore orgId={org.id} analysisId={analysis} startSource={startSource} />;
  } else if (permissions.loaded && (org === undefined || !sources.isPending)) {
    body = (
      <EmptyState icon="lock" title={t("explore.forbidden.title")}>
        {t("explore.forbidden.text")}
      </EmptyState>
    );
  }
  return <Page title={t("explore.title")}>{body}</Page>;
}

function Explore({
  orgId,
  analysisId,
  startSource,
}: {
  orgId: string;
  analysisId: string | undefined;
  /** The data source to start with, when the address names one. */
  startSource?: string | undefined;
}) {
  const { t, language, timeZone } = useI18n();
  const navigate = useNavigate();
  const meId = appRoute.useRouteContext().me.id;
  const calendar = useAnalysisCalendar();
  const permissions = useOrgPermissions();
  const datasourceId = useId();
  const datasources = useQuery(datasourcesQuery(orgId));
  const client = useQueryClient();
  const [historyOpen, setHistoryOpen] = useState(false);
  // Bumped when a history entry is loaded, so the editor starts over with its query.
  const [loads, setLoads] = useState(0);
  const kinds = useQuery(kindsQuery(orgId));
  // A query another page handed over (a graph panel's exploration) opens in the editor, unrun.
  const [handoff] = useState(peekExploreHandoff);
  useEffect(() => clearExploreHandoff(), []);
  const [chosen, setChosen] = useState<string | null>(
    () => handoff?.datasourceId ?? startSource ?? readPreference(LAST_DATASOURCE_KEY),
  );
  const [queries, setQueries] = useState<Record<string, unknown>>(() =>
    handoff === null ? {} : { [handoff.datasourceId]: handoff.query },
  );
  // Pages loaded after the first one through `nextCursor`, for the run they belong to.
  const [more, setMore] = useState<{
    of: Submitted | null;
    pages: DocumentSet[];
    loading: boolean;
    error: string | null;
  }>({ of: null, pages: [], loading: false, error: null });
  const [range, setRange] = useState<TextRange>({ from: "now-1h", to: "now" });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  // Live: the submitted query runs again whenever its data changes, pushed by the server.
  const [liveOn, setLiveOn] = useState(false);
  // The "load more" request on its way; a new run or leaving the page stops it on the server.
  const moreAbort = useRef<AbortController | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup is what runs when a new run starts
  useEffect(() => () => moreAbort.current?.abort(), [submitted]);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [filterError, setFilterError] = useState<string | null>(null);
  // Per data source: whether its editor holds text that does not parse yet.
  const [pendingText, setPendingText] = useState<Record<string, boolean>>({});
  const [panelType, setPanelType] = useState<string | null>(null);
  const [tab, setTab] = useState<"result" | "inspect">("result");
  const [adding, setAdding] = useState(false);
  const [exporting, setExporting] = useState(false);
  // Analysis steps on the result; they go with the panel when it is added to a dashboard.
  const [steps, setSteps] = useState<Step[]>([]);
  // The result and the steps editor share one run, a moment behind typing.
  const deferredSteps = useDeferredValue(steps);
  const tabsId = useId();
  // The saved analysis this editor holds, with the dialogs around saving it.
  const [saved, setSaved] = useState<SavedState | null>(null);
  const [saveDialog, setSaveDialog] = useState<SaveMode | null>(null);
  const [opening, setOpening] = useState(false);
  // `retry` sends the refused save again over the newer version (a rename or a move); without
  // it, overwriting saves the editor.
  const [conflict, setConflict] = useState<{
    newer: NewerVersion;
    compareOnly: boolean;
    retry?: ((version: number) => void) | undefined;
  } | null>(null);
  // Another analysis to open, waiting for "discard" while the editor has unsaved changes.
  const [switchTo, setSwitchTo] = useState<Analysis | null>(null);
  const [confirmLoad, setConfirmLoad] = useState<Analysis | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const folders = useQuery({
    ...foldersQuery(orgId),
    enabled: permissions.has("folders:read"),
  });
  // The analysis named in the address, loaded once into the editor.
  const requested = useQuery({
    ...analysisQuery(orgId, analysisId ?? ""),
    enabled: analysisId !== undefined && saved?.analysis.id !== analysisId,
  });
  // The open analysis, read again now and then: a newer version saved elsewhere shows at once.
  const watched = useQuery({
    ...analysisQuery(orgId, saved?.analysis.id ?? ""),
    enabled: saved !== null,
    refetchInterval: 30_000,
  });
  const newer =
    saved !== null &&
    watched.data !== undefined &&
    watched.data.id === saved.analysis.id &&
    watched.data.version > saved.analysis.version
      ? withModel(watched.data)
      : null;
  const newerAuthor = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "author", newer?.id ?? "", newer?.version ?? 0],
    queryFn: async ({ signal }) => {
      const page = await fetchVersions(orgId, newer?.id ?? "", { limit: 1 }, signal);
      return page.items[0]?.authorName ?? null;
    },
    enabled: newer !== null,
    retry: false,
  });
  // Leaving for Explore without an analysis in the address keeps the editor, now unsaved.
  const [lastId, setLastId] = useState(analysisId);
  if (lastId !== analysisId) {
    setLastId(analysisId);
    if (analysisId === undefined && saved !== null) {
      setSaved(null);
    }
  }
  // One save at a time: a second Ctrl+S while one is on its way does nothing, so the second
  // cannot run into a conflict with the first.
  const saving = useRef(false);
  const persist = useMutation({
    mutationFn: (job: () => Promise<Analysis>) => job(),
    onSettled: () => {
      saving.current = false;
    },
  });

  // Only the sources the caller may query (the role or a grant).
  const list = (datasources.data ?? []).filter(
    (source) => sourceAccess(source.access, permissions).query,
  );
  const datasource = list.find((d) => d.id === chosen) ?? list[0];
  const query =
    datasource === undefined ? null : (queries[datasource.id] ?? emptyQuery(datasource.kind));
  // A field holding something the server would refuse keeps the query from running; a MongoDB
  // field keeps its last valid text and runs that, as its editor says.
  const queryBlocked =
    datasource !== undefined &&
    pendingText[datasource.id] === true &&
    familyOf(datasource.kind) !== "mongo";

  const result = useQuery({
    queryKey: [EXPLORE_KEY, orgId, submitted],
    enabled: submitted !== null,
    staleTime: Number.POSITIVE_INFINITY,
    // Each run is a new answer of up to the response size limit; only the latest one stays.
    gcTime: RESULT_GC_MS,
    ...BUSY_RETRY,
    queryFn: async ({ signal, queryKey }) => {
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
          // Explore keeps what the user ran, for them alone (docs/api/explore-history.md).
          explore: true,
        },
        signal,
      );
      void client.invalidateQueries({ queryKey: [HISTORY_KEY, orgId] });
      dropOlderResults(client, [EXPLORE_KEY, orgId], queryKey);
      return outcomesOf(response, [REF_ID]);
    },
  });
  // Graph steps run with the query, in the database where the source can: the result above stays
  // the query's own (drawn as the graph); this run answers what the steps make of it.
  // Settled for a moment first: a number being typed or a choice being tried asks the database
  // once; the browser previews the steps meanwhile.
  const graphSteps = useSettled(
    graphStepsByQuery(deferredSteps).get(REF_ID),
    GRAPH_STEPS_SETTLE_MS,
  );
  const stepped = useQuery({
    queryKey: [EXPLORE_STEPS_KEY, orgId, submitted, graphSteps ?? null],
    enabled: submitted !== null && graphSteps !== undefined && result.data !== undefined,
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: RESULT_GC_MS,
    ...BUSY_RETRY,
    queryFn: async ({ signal }) => {
      const run = submitted as Submitted;
      const timeRange = { from: run.from, to: run.to };
      const response = await runQuery(
        orgId,
        {
          queries: [
            {
              refId: REF_ID,
              datasourceId: run.datasourceId,
              query: run.query,
              steps: graphSteps ?? [],
            },
          ],
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
  // A range that ends now moves with each live run; any other stays as it was resolved.
  const moving = submitted !== null && submitted.range.to.trim() === "now";
  const length = submitted === null ? 0 : submitted.to - submitted.from;
  const liveSpec: LiveSpec | null =
    !liveOn || submitted === null
      ? null
      : {
          queries: [
            { refId: REF_ID, datasourceId: submitted.datasourceId, query: submitted.query },
          ],
          ...(moving
            ? { lastMs: length }
            : { timeRange: { from: submitted.from, to: submitted.to } }),
          maxDataPoints: MAX_DATA_POINTS,
          intervalMs: intervalFor({ from: submitted.from, to: submitted.to }),
          variables: {},
        };
  // Results go to the run the subscription was started for; a new run starts a new one.
  const live = useLiveSubscription(
    orgId,
    liveSpec,
    [EXPLORE_KEY, orgId, submitted],
    (results, _at, key) => {
      // The pushed result replaces the run's answer; pages loaded after it belonged to the old one.
      void writeLiveResult(client, key, results, [REF_ID]);
      setMore({ of: null, pages: [], loading: false, error: null });
    },
  );
  const liveText = liveNote(t, live);

  function run(
    nextRange = range,
    nextQuery: unknown = query,
    target: DatasourceSummary | undefined = datasource,
    // A history entry replaces the editor's text, so text still waiting in a field is moot.
    ignoreBlocked = false,
  ) {
    // A field that holds something the server would refuse keeps the query from running; the
    // field says why.
    if (
      target === undefined ||
      !hasQuery(nextQuery, target.kind) ||
      (queryBlocked && !ignoreBlocked)
    ) {
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
      datasourceId: target.id,
      query: normalizeQuery(nextQuery, target.kind),
      range: nextRange,
      ...resolved.range,
      run: (current?.run ?? 0) + 1,
    }));
  }

  /** Puts a saved analysis into the editor and runs it. */
  function load(analysis: Analysis) {
    const full = withModel(analysis);
    const target = full?.model.targets[0];
    const source =
      target === undefined ? undefined : list.find((d) => d.id === target.datasourceId);
    if (full === null || target === undefined || source === undefined) {
      setLoadError(t("analyses.explore.noSource"));
      return;
    }
    setLoadError(null);
    setChosen(source.id);
    setQueries((current) => ({ ...current, [source.id]: target.query }));
    setPendingText((current) => ({ ...current, [source.id]: false }));
    setSteps(asSteps(full.model.steps));
    setPanelType(full.model.visualization.type);
    const nextRange = full.model.timeRange ?? range;
    setRange(nextRange);
    setFilterError(null);
    setLoads((n) => n + 1);
    setSaved({ analysis: full, baseline: null, openedAt: Date.now() });
    setConflict(null);
    client.setQueryData(analysisQuery(orgId, full.id).queryKey, full);
    run(nextRange, target.query, source, true);
  }
  // The analysis from the address goes into the editor once both it and the sources are there.
  const arrived =
    requested.data !== undefined &&
    requested.data.id === analysisId &&
    saved?.analysis.id !== analysisId &&
    datasources.data !== undefined
      ? requested.data
      : undefined;
  const onArrived = useEffectEvent((analysis: Analysis) => load(analysis));
  useEffect(() => {
    if (arrived !== undefined) {
      onArrived(arrived);
    }
  }, [arrived]);

  // "Summarize" at the result: the source and query of the run shown (board frame 9).
  const summarySource =
    submitted === null ? undefined : list.find((source) => source.id === submitted.datasourceId);
  const summary = useExploreAiSummary(
    orgId,
    {
      id: summarySource?.id ?? "",
      kind: summarySource?.kind ?? "",
      name: summarySource?.name ?? "",
    },
    submitted === null || summarySource === undefined
      ? null
      : {
          query: submitted.query,
          timeRange: { from: submitted.from, to: submitted.to },
          intervalMs: intervalFor({ from: submitted.from, to: submitted.to }),
        },
  );

  // A query handed over to be saved ("Als Panel speichern" in Fragen) opens the save dialog once
  // it is in the editor, for someone who may save analyses.
  const saveOnArrival = useRef(handoff?.save === true);
  // That dialog shows the query in full before it is saved: it was written in the chat.
  const [savingHandoff, setSavingHandoff] = useState(false);
  useEffect(() => {
    if (saveDialog === null) {
      setSavingHandoff(false);
    }
  }, [saveDialog]);
  const mayCreateAny =
    permissions.has("analyses:write") ||
    (folders.data ?? []).some((folder) => folder.access?.write === true);
  useEffect(() => {
    if (saveOnArrival.current && mayCreateAny && datasource !== undefined && query !== null) {
      saveOnArrival.current = false;
      setSaveDialog("save");
      setSavingHandoff(true);
    }
  }, [mayCreateAny, datasource, query]);

  if (datasources.isPending) {
    return <Skeleton lines={4} />;
  }
  if (datasources.isError) {
    return (
      <FormAlert>
        <p>{errorMessage(t, datasources.error)}</p>
        <button
          type="button"
          className="button button--secondary button--small notice__action"
          onClick={() => void datasources.refetch()}
          disabled={datasources.isFetching}
        >
          {t("common.retry")}
        </button>
      </FormAlert>
    );
  }
  if (datasource === undefined || query === null) {
    return (
      <EmptyState
        icon="dataSources"
        title={t("explore.noDatasources.title")}
        actions={
          permissions.has("datasources:write") ? (
            <Link to="/data-sources/new" search={{}} className="button button--secondary">
              <Icon name="plus" />
              {t("explore.noDatasources.add")}
            </Link>
          ) : undefined
        }
      >
        {permissions.has("datasources:write")
          ? t("explore.noDatasources.textAdmin")
          : t("explore.noDatasources.text")}
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
    moreAbort.current?.abort();
    const controller = new AbortController();
    moreAbort.current = controller;
    try {
      const timeRange = { from: run.from, to: run.to };
      const response = await runQuery(
        orgId,
        {
          queries: [{ refId: REF_ID, datasourceId: run.datasourceId, query: run.query, cursor }],
          timeRange,
          maxDataPoints: MAX_DATA_POINTS,
          intervalMs: intervalFor(timeRange),
          variables: {},
        },
        controller.signal,
      );
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
      // Stopped on purpose (a new run, or the page was left): nothing to report.
      if (controller.signal.aborted) {
        return;
      }
      keep((pages) => ({ of: run, pages, loading: false, error: errorMessage(t, problem) }));
    }
  }
  // An entry goes into the editor without running; a data source the caller can no longer pick
  // is never loaded (the server hides such entries, so this only guards a stale list).
  function loadEntry(entry: HistoryEntry): DatasourceSummary | undefined {
    const target = list.find((d) => d.id === entry.datasourceId);
    if (target === undefined) {
      return undefined;
    }
    setChosen(target.id);
    setFilterError(null);
    writePreference(LAST_DATASOURCE_KEY, target.id);
    setQueries((current) => ({ ...current, [target.id]: entry.query }));
    setPendingText((current) => ({ ...current, [target.id]: false }));
    setLoads((n) => n + 1);
    return target;
  }
  const kindShapes = kinds.data?.find((k) => k.kind === datasource.kind)?.shapes ?? ["frame"];
  const takesDocuments = kindShapes.includes("documents");
  // Paths to suggest for the projection: those of the last result's documents.
  const resultFields = documentsOf(outcomes).flatMap(({ documents }) =>
    projectionPaths(schemaOf(documents)),
  );
  // One list of steps for the result: the projection (edited under the query) and the
  // analysis steps after it, run once for the panel and the steps editor.
  const projection = projectionFor(steps, REF_ID);
  const projected = projection !== undefined && projectionApplies(projection);
  // A projection step the server would refuse waits for a fix before it leaves the page.
  const blocked = hasProjectionProblems(steps);
  const stepsRun = runPanelSteps(
    deferredSteps,
    outcomes,
    calendar,
    graphSteps === undefined ? undefined : stepped.data,
  );
  // The suggestion follows what the panel will get: documents, or the frame of a projection.
  const results: QueryResult[] = [
    ...outcomes.flatMap((o) =>
      "result" in o && !(projected && o.result.shape === "documents") ? [o.result] : [],
    ),
    ...(projected ? stepsRun.frames.map((f) => ({ shape: "frame" as const, frame: f.frame })) : []),
  ];
  const shapes: Shape[] = projected ? [...new Set<Shape>([...kindShapes, "frame"])] : kindShapes;
  const choices = panelsForShapes(shapes);
  const type = panelType ?? (results.length > 0 ? suggestPanel(results) : "table");
  // A saved analysis keeps its visualization options while its type stays.
  const savedLook =
    saved !== null && saved.analysis.model.visualization.type === type
      ? saved.analysis.model.visualization
      : undefined;
  const panel: PanelModel = {
    id: "explore",
    type,
    title: "",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets:
      submitted === null
        ? []
        : [{ refId: REF_ID, datasourceId: submitted.datasourceId, query: submitted.query }],
    transformations: steps,
    options: savedLook?.options ?? {},
    fieldConfig: savedLook?.fieldConfig ?? {},
  };

  /** The editor as an analysis model; `base` gives the name and the queries beyond the first. */
  function currentModel(
    base: AnalysisModel | undefined,
    keepRange: boolean,
    target: DatasourceSummary,
    text: unknown,
  ): AnalysisModel {
    const sameType = base?.visualization.type === type;
    return {
      schemaVersion: ANALYSIS_SCHEMA_VERSION,
      title: base?.title ?? "",
      description: base?.description,
      timeRange: keepRange ? range : null,
      targets: [
        { refId: REF_ID, datasourceId: target.id, query: normalizeQuery(text, target.kind) },
        ...(base?.targets.slice(1) ?? []),
      ],
      steps: storableTransformations(steps),
      visualization: {
        type,
        options: sameType ? (base?.visualization.options ?? {}) : {},
        fieldConfig: sameType ? (base?.visualization.fieldConfig ?? {}) : {},
      },
    };
  }
  const mine =
    saved === null
      ? null
      : currentModel(
          saved.analysis.model,
          saved.analysis.model.timeRange !== null,
          datasource,
          query,
        );
  // The first render after loading is what "unchanged" means.
  if (saved !== null && saved.baseline === null && mine !== null) {
    setSaved({ ...saved, baseline: editedPart(mine) });
  }
  const dirty =
    saved !== null &&
    saved.baseline !== null &&
    mine !== null &&
    editedPart(mine) !== saved.baseline;
  const allFolders = folders.data ?? [];
  const mayWrite = saved?.analysis.access.write ?? false;
  const mayCreate =
    permissions.has("analyses:write") || allFolders.some((folder) => folder.access?.write === true);

  /** A saved or created analysis becomes the open one; `baseline` is what it matched. */
  function adopt(analysis: Analysis, baseline: string | null) {
    const full = withModel(analysis);
    if (full === null) {
      return;
    }
    setSaved((current) => ({
      analysis: full,
      baseline,
      openedAt: current?.analysis.id === full.id ? current.openedAt : Date.now(),
    }));
    setConflict(null);
    client.setQueryData(analysisQuery(orgId, full.id).queryKey, full);
    void client.invalidateQueries({ queryKey: [ANALYSES_KEY, orgId, "list"] });
    if (analysisId !== full.id) {
      void navigate({ to: "/explore", search: { analysis: full.id }, replace: true });
    }
  }

  async function showConflict(
    current: Analysis,
    compareOnly: boolean,
    retry?: (version: number) => void,
  ) {
    const full = withModel(current);
    if (full === null) {
      return;
    }
    const authorName = await fetchVersions(orgId, full.id, { limit: 1 })
      .then((page) => page.items[0]?.authorName ?? null)
      .catch(() => null);
    setConflict({ newer: { analysis: full, authorName }, compareOnly, retry });
  }

  function saveCurrent(version?: number) {
    if (datasource === undefined || query === null || saving.current) {
      return;
    }
    if (saved === null) {
      if (mayCreate) {
        persist.reset();
        setSaveDialog("save");
      }
      return;
    }
    if (!mayWrite) {
      persist.reset();
      setSaveDialog("saveAs");
      return;
    }
    const model = currentModel(
      saved.analysis.model,
      saved.analysis.model.timeRange !== null,
      datasource,
      query,
    );
    saving.current = true;
    persist.mutate(
      () =>
        saveAnalysis(orgId, saved.analysis.id, {
          model,
          version: version ?? saved.analysis.version,
        }),
      {
        onSuccess: (analysis) => {
          adopt(analysis, editedPart(model));
          showToast({ message: t("analyses.explore.savedToast", { title: analysis.title }) });
        },
        onError: (error) => {
          const current = analysisFromConflict(error);
          if (current !== null) {
            void showConflict(current, false);
          } else {
            showErrorToast(errorMessage(t, error));
          }
        },
      },
    );
  }

  function submitDialog(mode: SaveMode, values: SaveValues) {
    if (datasource === undefined || query === null || saving.current) {
      return;
    }
    if (mode === "save" || mode === "saveAs") {
      const model = {
        ...currentModel(saved?.analysis.model, values.keepRange, datasource, query),
        title: values.title,
        description: values.description === "" ? undefined : values.description,
      };
      saving.current = true;
      persist.mutate(() => createAnalysis(orgId, { model, folderId: values.folderId }), {
        onSuccess: (analysis) => {
          setSaveDialog(null);
          adopt(analysis, editedPart(model));
          showToast({
            message: t("analyses.explore.savedIn", {
              place: placeLabel(t, allFolders, analysis.folderId),
            }),
            action: {
              label: t("analyses.explore.showInList"),
              run: () =>
                void navigate({
                  to: "/explore/saved",
                  search: analysis.folderId === null ? {} : { folder: analysis.folderId },
                }),
            },
          });
        },
      });
      return;
    }
    if (saved === null) {
      return;
    }
    const base = saved.analysis.model;
    const model =
      mode === "rename"
        ? {
            ...base,
            title: values.title,
            description: values.description === "" ? undefined : values.description,
          }
        : base;
    const send = (version: number) => {
      saving.current = true;
      persist.mutate(
        () =>
          saveAnalysis(orgId, saved.analysis.id, {
            model,
            version,
            ...(mode === "move" ? { folderId: values.folderId } : {}),
          }),
        {
          onSuccess: (analysis) => {
            setSaveDialog(null);
            adopt(analysis, saved.baseline);
            showToast({
              message:
                mode === "move"
                  ? t("analyses.list.moved", {
                      title: analysis.title,
                      place: placeLabel(t, allFolders, analysis.folderId),
                    })
                  : t("analyses.explore.savedToast", { title: analysis.title }),
            });
          },
          // Saved elsewhere meanwhile: the same choice as for a save, then this change again.
          onError: (error) => {
            const current = analysisFromConflict(error);
            if (current !== null) {
              setSaveDialog(null);
              void showConflict(current, false, send);
            }
          },
        },
      );
    };
    send(saved.analysis.version);
  }

  const groups = placeGroups(t, allFolders, permissions.has("analyses:write"));
  const firstPlace = groups[0]?.places[0]?.id ?? null;

  return (
    <div className="explore">
      <SaveShortcuts
        onSave={() => saveCurrent()}
        onSaveAs={() => {
          if (mayCreate) {
            persist.reset();
            setSaveDialog(saved === null ? "save" : "saveAs");
          }
        }}
        onOpen={permissions.has("analyses:read") ? () => setOpening(true) : undefined}
      />
      <LeaveGuard dirty={dirty} title={saved?.analysis.title ?? ""} />
      {saved === null ? null : (
        <SavedHeading analysis={saved.analysis} folders={allFolders} dirty={dirty} />
      )}
      {loadError === null ? null : <FormAlert>{loadError}</FormAlert>}
      {requested.isError ? <FormAlert>{errorMessage(t, requested.error)}</FormAlert> : null}
      {newer !== null && conflict === null && saved !== null ? (
        <ConflictNotice
          newer={{ analysis: newer, authorName: newerAuthor.data ?? null }}
          workingVersion={saved.analysis.version}
          onCompare={() =>
            setConflict({
              newer: { analysis: newer, authorName: newerAuthor.data ?? null },
              compareOnly: true,
            })
          }
          onLoad={() => (dirty ? setConfirmLoad(newer) : load(newer))}
        />
      ) : null}
      <div className="explore__toolbar">
        {saved === null ? (
          <span className="explore-saved__untitled">{t("analyses.explore.untitled")}</span>
        ) : null}
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
        <div className="explore__run">
          {saved === null ? null : <SavedAgo analysis={saved.analysis} meId={meId} />}
          {permissions.has("analyses:read") ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={() => setOpening(true)}
              aria-keyshortcuts="Control+O"
              title={t("analyses.keys.open")}
            >
              <Icon name="folder" />
              {t("analyses.explore.open")}
            </button>
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={historyOpen}
            onClick={() => setHistoryOpen((open) => !open)}
          >
            <Icon name="history" />
            {t("explore.history.button")}
          </button>
          <TimeRangePicker
            value={range}
            onChange={(next) => {
              setRange(next);
              if (submitted !== null) {
                run(next);
              }
            }}
          />
          {mayCreate || mayWrite ? (
            <SaveControls
              saved={saved?.analysis ?? null}
              dirty={dirty}
              mayWrite={mayWrite}
              busy={persist.isPending}
              actions={{
                save: () => saveCurrent(),
                saveAs: () => {
                  persist.reset();
                  setSaveDialog("saveAs");
                },
                rename: () => {
                  persist.reset();
                  setSaveDialog("rename");
                },
                move: () => {
                  persist.reset();
                  setSaveDialog("move");
                },
                versions: () => {
                  if (saved !== null) {
                    void navigate({
                      to: "/explore/saved/$analysisId/versions",
                      params: { analysisId: saved.analysis.id },
                    });
                  }
                },
                discard: () => {
                  if (saved !== null) {
                    setConfirmLoad(saved.analysis);
                  }
                },
              }}
            />
          ) : null}
          <button
            type="button"
            className="button button--secondary"
            aria-pressed={liveOn}
            aria-describedby={`${tabsId}-live-hint`}
            onClick={() => {
              if (!liveOn) {
                liveClient(orgId).restart();
              }
              setLiveOn(!liveOn);
            }}
          >
            {t("live.explore.toggle")}
          </button>
          <span className="visually-hidden" id={`${tabsId}-live-hint`}>
            {t("live.explore.hint")}
          </span>
          <button
            type="button"
            className="button button--primary"
            onClick={() => run()}
            disabled={!hasQuery(query, datasource.kind) || queryBlocked}
          >
            {result.isFetching ? t("explore.running") : t("explore.run")}
          </button>
        </div>
      </div>
      <div className="explore__body">
        <div className="explore__main">
          {saved?.analysis.model.description === undefined ? null : (
            <p className="explore-saved__description">{saved.analysis.model.description}</p>
          )}
          {rangeError === null ? null : <FormAlert>{rangeError}</FormAlert>}
          {filterError === null ? null : <FormAlert>{filterError}</FormAlert>}
          <AiGate feature="explain">
            <ExploreAiTools
              key={datasource.id}
              orgId={orgId}
              source={{ id: datasource.id, kind: datasource.kind, name: datasource.name }}
              query={query}
              hasQuery={hasQuery(query, datasource.kind)}
              onApply={(draft) =>
                setQueries((current) => ({
                  ...current,
                  [datasource.id]:
                    // A search draft is a Lucene query: the index and fields of the query stay.
                    familyOf(datasource.kind) === "search" && typeof query === "object"
                      ? {
                          ...Object.fromEntries(
                            Object.entries(query ?? {}).filter(([k]) => k !== "dsl"),
                          ),
                          ...(draft as object),
                        }
                      : draft,
                }))
              }
            />
          </AiGate>
          <QueryEditor
            key={`${datasource.id}:${loads}`}
            orgId={orgId}
            datasource={datasource}
            query={query}
            onChange={(next) => setQueries((current) => ({ ...current, [datasource.id]: next }))}
            onRun={() => run()}
            onPendingText={(pending) =>
              setPendingText((current) =>
                current[datasource.id] === pending
                  ? current
                  : { ...current, [datasource.id]: pending },
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
                // The projection joins the one list of steps, before the analysis steps.
                setSteps((all) => asSteps(withProjection(all, REF_ID, next)))
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
                {summary.button}
                {liveText === null ? null : (
                  <p className="explore__live" role="status">
                    {liveText.label}: {liveText.detail}
                  </p>
                )}
                {blocked ? (
                  <p className="field__error" id={`${tabsId}-blocked`}>
                    {t("documents.projection.blockedExplore")}
                  </p>
                ) : null}
              </div>
              {summary.card}
              {/* Both panels exist, so every tab's aria-controls points at an element. */}
              <div
                className="explore__panel"
                role="tabpanel"
                id={`${tabsId}-result`}
                aria-labelledby={`${tabsId}-result-tab`}
                hidden={tab !== "result"}
              >
                {tab === "result" ? (
                  <PanelHostContext value={{ orgId }}>
                    <PanelBody
                      panel={panel}
                      title={t("explore.result")}
                      range={
                        moving && live.at !== undefined && live.at > submitted.to
                          ? { from: live.at - length, to: live.at }
                          : { from: submitted.from, to: submitted.to }
                      }
                      pending={result.isPending}
                      error={result.error}
                      onRetry={() => void result.refetch()}
                      outcomes={outcomes}
                      revision={`${submitted.run}:${current.pages.length}:${result.dataUpdatedAt}`}
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
                              setQueries((current) => ({
                                ...current,
                                [datasource.id]: added.query,
                              }));
                              run(range, added.query);
                            }
                          : undefined
                      }
                      distribution={{
                        // Over the whole result of the run shown, in the database; each run
                        // asks again, loading more pages does not.
                        identity: JSON.stringify([
                          submitted.datasourceId,
                          submitted.query,
                          submitted.range,
                        ]),
                        manual: submitted.run,
                        run: (_refId, ask, signal) => {
                          const timeRange = { from: submitted.from, to: submitted.to };
                          return fetchDistribution(
                            orgId,
                            {
                              datasourceId: submitted.datasourceId,
                              query: submitted.query,
                              timeRange,
                              intervalMs: intervalFor(timeRange),
                              variables: {},
                              ...ask,
                            },
                            signal,
                          );
                        },
                      }}
                      stepsRun={stepsRun}
                      kindOf={(id) => list.find((source) => source.id === id)?.kind}
                    />
                  </PanelHostContext>
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
        </div>
        {/* The steps and what to do with the result, beside it as on the blueprint. */}
        <div className="explore__rail">
          {historyOpen ? (
            <HistoryPanel
              orgId={orgId}
              sources={list}
              onClose={() => setHistoryOpen(false)}
              onLoad={(entry) => {
                loadEntry(entry);
              }}
              onRun={(entry) => {
                const target = loadEntry(entry);
                run(range, entry.query, target, true);
              }}
            />
          ) : null}
          <aside className="explore__aside" aria-label={t("explore.aside")}>
            <StepsEditor
              steps={steps}
              onChange={setSteps}
              refIds={[REF_ID]}
              inputs={namedInputs(outcomes)}
              run={stepsRun}
              kindOf={() =>
                submitted === null
                  ? undefined
                  : list.find((source) => source.id === submitted.datasourceId)?.kind
              }
            />
            <div className="explore__aside-actions">
              {permissions.has("data:export") ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setExporting(true)}
                  disabled={result.data === undefined || blocked}
                  aria-describedby={blocked ? `${tabsId}-blocked` : undefined}
                >
                  {t("analysis.export.button")}
                </button>
              ) : null}
              {permissions.has("dashboards:write") ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={() => setAdding(true)}
                  disabled={result.data === undefined || blocked}
                  aria-describedby={blocked ? `${tabsId}-blocked` : undefined}
                >
                  {t("explore.addToDashboard")}
                </button>
              ) : null}
            </div>
          </aside>
        </div>
      </div>
      {exporting && submitted !== null ? (
        <ExportDialog
          frames={stepsRun.frames.map((f) => f.name)}
          run={(choice, signal) => {
            const timeRange = { from: submitted.from, to: submitted.to };
            return exportQuery(
              orgId,
              {
                queries: [
                  { refId: REF_ID, datasourceId: submitted.datasourceId, query: submitted.query },
                ],
                timeRange,
                maxDataPoints: MAX_DATA_POINTS,
                intervalMs: intervalFor(timeRange),
                variables: {},
                // As stored: without the columns that still wait for a path.
                steps: storableTransformations(steps),
                format: choice.format,
                language: choice.language,
                ...(choice.frame === undefined ? {} : { frame: choice.frame }),
                title: datasource.name,
              },
              signal,
            );
          }}
          onClose={() => setExporting(false)}
        />
      ) : null}
      {adding && submitted !== null ? (
        <AddToDashboardDialog
          orgId={orgId}
          panel={
            // A saved analysis without changes goes in linked, so the panel follows its saves.
            saved !== null && !dirty
              ? {
                  ...panel,
                  title: saved.analysis.title,
                  transformations: [],
                  targets: [],
                  analysisId: saved.analysis.id,
                }
              : {
                  ...panel,
                  title: saved?.analysis.title ?? datasource.name,
                  transformations: storableTransformations(steps),
                }
          }
          range={submitted.range}
          onClose={() => setAdding(false)}
        />
      ) : null}
      {opening ? (
        <OpenDialog
          orgId={orgId}
          onOpen={(analysis) => {
            setOpening(false);
            if (analysis.id === saved?.analysis.id) {
              return;
            }
            // Unsaved changes are not dropped by opening another analysis without asking.
            if (dirty) {
              setSwitchTo(analysis);
              return;
            }
            void navigate({ to: "/explore", search: { analysis: analysis.id } });
          }}
          onClose={() => setOpening(false)}
        />
      ) : null}
      {saveDialog === null ? null : (
        <SaveAnalysisDialog
          mode={saveDialog}
          initial={{
            title:
              saved === null
                ? ""
                : saveDialog === "saveAs"
                  ? t("analyses.list.copyOf", { title: saved.analysis.title })
                  : saved.analysis.title,
            description: saved?.analysis.model.description ?? "",
            folderId: saved === null ? firstPlace : saved.analysis.folderId,
            keepRange: saved !== null && saved.analysis.model.timeRange !== null,
          }}
          folders={allFolders}
          canTop={permissions.has("analyses:write")}
          summary={{
            sourceName: datasource.name,
            sourceKind: datasource.kind,
            queries: saved?.analysis.model.targets.length ?? 1,
            steps: asSteps(storableTransformations(steps)).length,
            visualization: visualizationName(t, type),
          }}
          rangeLabel={rangeLabel(t, language, range, timeZone)}
          busy={persist.isPending}
          error={persist.isError ? errorMessage(t, persist.error) : undefined}
          query={savingHandoff && saveDialog === "save" ? query : undefined}
          onSubmit={(values) => submitDialog(saveDialog, values)}
          onClose={() => setSaveDialog(null)}
        />
      )}
      {conflict === null || saved === null || mine === null ? null : (
        <ConflictDialog
          base={saved.analysis.model}
          mine={mine}
          newer={conflict.newer}
          openedAt={saved.openedAt}
          compareOnly={conflict.compareOnly}
          busy={persist.isPending}
          onOverwrite={() => {
            const version = conflict.newer.analysis.version;
            if (conflict.retry === undefined) {
              saveCurrent(version);
            } else {
              conflict.retry(version);
            }
          }}
          onLoad={() => {
            const target = conflict.newer.analysis;
            setConflict(null);
            if (dirty) {
              setConfirmLoad(target);
            } else {
              load(target);
            }
          }}
          onSaveCopy={() => {
            setConflict(null);
            persist.reset();
            setSaveDialog("saveAs");
          }}
          onClose={() => setConflict(null)}
        />
      )}
      {switchTo === null ? null : (
        <ConfirmDialog
          title={t("analyses.leave.title")}
          confirmLabel={t("analyses.leave.discard")}
          cancelLabel={t("analyses.leave.stay")}
          onCancel={() => setSwitchTo(null)}
          onConfirm={() => {
            const target = switchTo;
            setSwitchTo(null);
            void navigate({ to: "/explore", search: { analysis: target.id } });
          }}
        >
          {t("analyses.leave.text", { title: saved?.analysis.title ?? "" })}
        </ConfirmDialog>
      )}
      {confirmLoad === null ? null : (
        <ConfirmDialog
          title={
            confirmLoad.version === saved?.analysis.version
              ? t("analyses.discard.title")
              : t("analyses.discard.loadTitle", { version: confirmLoad.version })
          }
          confirmLabel={
            confirmLoad.version === saved?.analysis.version
              ? t("analyses.discard.confirm")
              : t("analyses.discard.loadConfirm", { version: confirmLoad.version })
          }
          onCancel={() => setConfirmLoad(null)}
          onConfirm={() => {
            const target = confirmLoad;
            setConfirmLoad(null);
            load(target);
          }}
        >
          {t("analyses.discard.text")}
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Asks before leaving Explore (a link, the browser's back button) with unsaved changes. */
function LeaveGuard({ dirty, title }: { dirty: boolean; title: string }) {
  const { t } = useI18n();
  const leave = useLeaveGuard(dirty, t("analyses.leave.text", { title }), {
    title: t("analyses.leave.title"),
    confirm: t("analyses.leave.discard"),
    cancel: t("analyses.leave.stay"),
  });
  return leave.dialog;
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
    const next = tabForKey(TABS, tab, event.key);
    if (next === undefined) {
      return;
    }
    event.preventDefault();
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
