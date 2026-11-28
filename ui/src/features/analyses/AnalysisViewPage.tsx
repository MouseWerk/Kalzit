import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { type ComponentProps, useEffect, useState } from "react";
import { isRecord } from "../../api/client";
import type { Pattern } from "../../api/generated/shapes";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { LazyPiece, pieceSource } from "../../components/LazyPiece";
import { Page } from "../../components/Page";
import { loadArea, useI18n } from "../../i18n/i18n";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { PanelHostContext } from "../../panels/host";
import { foldersQuery } from "../dashboards/api";
import type { PanelModel } from "../dashboards/model";
import { PanelBody } from "../dashboards/PanelCard";
import { outcomesOf } from "../dashboards/results";
import { TimeRangePicker } from "../dashboards/TimeRangePicker";
import {
  intervalFor,
  MAX_DATA_POINTS,
  resolveRange,
  type TextRange,
} from "../dashboards/timeRange";
import { errorMessage } from "../dashboards/ui/errors";
import { usePanelPages } from "../dashboards/usePanelPages";
import { panelDistribution } from "../dashboards/usePanelResults";
import { datasourcesQuery } from "../datasources/api";
import { KindMark } from "../datasources/kindMarks";
import { queryText } from "../datasources/queryKinds";
import { fillTitle } from "../graphPatterns/pattern";
import type { AboutTemplate, TemplateRunInputs } from "../graphPatterns/TemplateInputs";
import {
  ANALYSES_KEY,
  type Analysis,
  type AnalysisModel,
  analysisQuery,
  recordOpen,
  runAnalysis,
  templateParameters,
} from "./api";
import { placeLabel } from "./places";
import "../explore/explore.css";
import "./analyses.css";

const viewRoute = getRouteApi("/_app/explore/saved/$analysisId");

// A search template's inputs and "Über diese Suche" load with the texts of graph patterns.
const TEMPLATE_RUN = pieceSource<ComponentProps<typeof TemplateRunInputs>>(() =>
  loadArea("graphPatterns")
    .then(() => import("../graphPatterns/TemplateInputs"))
    .then((module) => ({ default: module.TemplateRunInputs })),
);
const ABOUT = pieceSource<ComponentProps<typeof AboutTemplate>>(() =>
  loadArea("graphPatterns")
    .then(() => import("../graphPatterns/TemplateInputs"))
    .then((module) => ({ default: module.AboutTemplate })),
);

/** The range an analysis opens with when it keeps none. */
const DEFAULT_RANGE: TextRange = { from: "now-1h", to: "now" };

/**
 * A saved analysis to look at and run, without the editor: what its readers may do, also without
 * the right to query its data source. Its stored queries run through the analysis's own route;
 * the steps run here, and the result is drawn with the analysis's visualization.
 */
export function AnalysisViewPage() {
  const { t } = useI18n();
  const org = useCurrentOrg();
  const permissions = useOrgPermissions();
  const { analysisId } = viewRoute.useParams();
  const analysis = useQuery({
    ...analysisQuery(org?.id ?? "", analysisId),
    enabled: org !== undefined && permissions.has("analyses:read"),
  });
  useDocumentTitle("analyses.view.title");
  // For the list's "last opened" order, once per analysis shown; a failure changes nothing here.
  const openedOrg = org?.id;
  const openedId = analysis.data?.id;
  useEffect(() => {
    if (openedOrg !== undefined && openedId !== undefined) {
      recordOpen(openedOrg, openedId).catch(() => undefined);
    }
  }, [openedOrg, openedId]);
  let body = null;
  if (org !== undefined && !permissions.has("analyses:read") && permissions.loaded) {
    body = (
      <EmptyState icon="lock" title={t("analyses.forbidden.title")}>
        {t("analyses.forbidden.text")}
      </EmptyState>
    );
  } else if (analysis.isError) {
    body = <FormAlert>{errorMessage(t, analysis.error)}</FormAlert>;
  } else if (org !== undefined && analysis.data?.model !== undefined) {
    body = (
      <AnalysisView
        key={`${analysis.data.id}:${analysis.data.version}`}
        orgId={org.id}
        analysis={analysis.data}
        model={analysis.data.model}
      />
    );
  } else {
    body = <p className="loading">{t("common.loading")}</p>;
  }
  return (
    <Page
      title={analysis.data?.title ?? t("analyses.view.title")}
      {...(analysis.data?.model?.description === undefined
        ? {}
        : { lead: analysis.data.model.description })}
    >
      {body}
    </Page>
  );
}

function AnalysisView({
  orgId,
  analysis,
  model,
}: {
  orgId: string;
  analysis: Analysis;
  model: AnalysisModel;
}) {
  const { t, language } = useI18n();
  const permissions = useOrgPermissions();
  const folders = useQuery({ ...foldersQuery(orgId), enabled: permissions.has("folders:read") });
  const sources = useQuery(datasourcesQuery(orgId));
  // The kept range, or one picked here (not saved), resolved once per run so the result and its
  // axes belong to one moment.
  const [shown, setShown] = useState(() => {
    const range = model.timeRange ?? DEFAULT_RANGE;
    return { range, run: 0, resolved: resolveRange(range, Date.now()) };
  });
  const { range, run, resolved } = shown;
  const timeRange = resolved.ok ? resolved.range : null;
  const apply = (next: TextRange) =>
    setShown((current) => ({
      range: next,
      run: current.run + 1,
      resolved: resolveRange(next, Date.now()),
    }));
  const refIds = model.targets.filter((target) => target.hide !== true).map((t) => t.refId);
  // A search template (board Graph083, frame 12) runs once its inputs are given, with them alone.
  const inputs = templateParameters(model);
  const template = inputs.length > 0;
  const [values, setValues] = useState<Record<string, unknown>>({});
  const [given, setGiven] = useState<Record<string, unknown> | null>(null);
  const result = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "view", analysis.id, analysis.version, timeRange, run, given],
    queryFn: async ({ signal }) =>
      timeRange === null
        ? []
        : outcomesOf(
            await runAnalysis(
              orgId,
              analysis.id,
              {
                timeRange,
                intervalMs: intervalFor(timeRange),
                maxDataPoints: MAX_DATA_POINTS,
                ...(given === null ? {} : { variables: given }),
              },
              signal,
            ),
            refIds,
          ),
    enabled: timeRange !== null && (!template || given !== null),
  });
  const kindOf = (datasourceId: string) =>
    sources.data?.find((source) => source.id === datasourceId)?.kind;
  const source = sources.data?.find((s) => s.id === model.targets[0]?.datasourceId);
  const panel: PanelModel = {
    id: "analysis",
    type: model.visualization.type,
    title: "",
    grid: { x: 0, y: 0, w: 12, h: 8 },
    targets: model.targets,
    transformations: model.steps,
    options: model.visualization.options ?? {},
    fieldConfig: model.visualization.fieldConfig ?? {},
  };
  // Pages after a document set the source has more of, through the analysis's own route.
  const paged = usePanelPages(
    {
      orgId,
      dashboardId: "",
      panel,
      range: timeRange ?? { from: 0, to: 0 },
      variables: {},
      source: "stored",
      run,
      route: { kind: "analysis", analysisId: analysis.id },
    },
    result,
  );
  const place = placeLabel(t, folders.data ?? [], analysis.folderId);
  return (
    <div className="explore">
      <Breadcrumbs
        crumbs={[
          { label: t("analyses.list.title"), link: { to: "/explore/saved", search: {} } },
          { label: analysis.title },
        ]}
      />
      <div className="explore__toolbar">
        <span className="explore-saved__ago">
          {t("analyses.view.place", { place })}
          {source === undefined ? null : (
            <span className="analysis-save__source">
              {" · "}
              <KindMark kind={source.kind} small />
              {source.name}
            </span>
          )}
        </span>
        <div className="explore__run">
          <TimeRangePicker value={range} onChange={apply} />
          <button
            type="button"
            className="button button--secondary"
            aria-busy={result.isFetching || undefined}
            onClick={() => apply(range)}
            disabled={result.isFetching}
          >
            <Icon name="refresh" />
            {t("analyses.view.run")}
          </button>
          <Link
            to="/explore/saved/$analysisId/versions"
            params={{ analysisId: analysis.id }}
            className="button button--secondary"
          >
            {t("analyses.menu.versions")}
          </Link>
          {analysis.mayQuery ? (
            <Link
              to="/explore"
              search={{ analysis: analysis.id }}
              className="button button--primary"
            >
              {t("analyses.linked.edit")}
            </Link>
          ) : null}
        </div>
      </div>
      {resolved.ok ? null : <FormAlert>{t(`dashboards.time.error.${resolved.error}`)}</FormAlert>}
      {analysis.mayQuery ? null : <p className="explore__hint">{t("analyses.view.readOnly")}</p>}
      {template ? (
        <LazyPiece
          source={TEMPLATE_RUN}
          props={{
            orgId,
            analysisId: analysis.id,
            parameters: inputs,
            values,
            busy: result.isFetching,
            ran: given !== null,
            onValues: setValues,
            onRun: (variables: Record<string, unknown>) => {
              setGiven(variables);
              apply(range);
            },
          }}
          pending={<p className="loading">{t("common.loading")}</p>}
        />
      ) : null}
      <div className={template ? "analysis-template" : undefined}>
        <section
          className="explore__result"
          aria-label={t("explore.result")}
          aria-busy={result.isFetching}
        >
          {template && given !== null ? (
            <h2 className="analysis-template__title">{fillTitle(analysis.title, given)}</h2>
          ) : null}
          <div className="explore__panel">
            {timeRange === null || (template && given === null) ? null : (
              <PanelHostContext value={{ orgId }}>
                <PanelBody
                  panel={panel}
                  title={analysis.title}
                  range={timeRange}
                  pending={result.isPending}
                  error={result.error}
                  onRetry={() => void result.refetch()}
                  fetching={result.isFetching}
                  outcomes={paged.outcomes}
                  revision={`${result.dataUpdatedAt}:${paged.pageCount}`}
                  more={paged.more}
                  kindOf={kindOf}
                  distribution={panelDistribution(
                    {
                      orgId,
                      dashboardId: "",
                      panel,
                      range: timeRange,
                      variables: {},
                      source: "stored",
                      manual: run,
                      route: { kind: "analysis", analysisId: analysis.id },
                    },
                    kindOf,
                  )}
                />
              </PanelHostContext>
            )}
          </div>
        </section>
        {template ? (
          <LazyPiece
            source={ABOUT}
            props={{
              description: model.description,
              pattern: firstPattern(model),
              query:
                firstPattern(model) === undefined ? queryText(model.targets[0]?.query) : undefined,
              compileOn:
                analysis.mayQuery && source !== undefined
                  ? { orgId, datasourceId: source.id }
                  : undefined,
              source: source?.name,
              place,
              // When, and who saved last while that account exists.
              changed: [
                new Date(analysis.updatedAt).toLocaleString(language),
                analysis.updatedByName,
              ]
                .filter((part) => part !== null)
                .join(" · "),
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

/** The pattern of the template's first target, when it is one. */
function firstPattern(model: AnalysisModel): Pattern | undefined {
  const query = model.targets[0]?.query;
  return isRecord(query) && isRecord(query.pattern) && Array.isArray(query.pattern.nodes)
    ? (query.pattern as unknown as Pattern)
    : undefined;
}
