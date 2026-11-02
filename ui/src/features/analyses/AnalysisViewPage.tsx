import { useQuery } from "@tanstack/react-query";
import { getRouteApi, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Breadcrumbs } from "../../components/Breadcrumbs";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Icon } from "../../components/Icon";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
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
import { panelDistribution } from "../dashboards/usePanelResults";
import { datasourcesQuery } from "../datasources/api";
import { KindMark } from "../datasources/kindMarks";
import { ANALYSES_KEY, type Analysis, type AnalysisModel, analysisQuery, runAnalysis } from "./api";
import { placeLabel } from "./places";
import "../explore/explore.css";
import "./analyses.css";

const viewRoute = getRouteApi("/_app/explore/saved/$analysisId");

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
  const { t } = useI18n();
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
  const result = useQuery({
    queryKey: [ANALYSES_KEY, orgId, "view", analysis.id, analysis.version, timeRange, run],
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
              },
              signal,
            ),
            refIds,
          ),
    enabled: timeRange !== null,
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
      <section
        className="explore__result"
        aria-label={t("explore.result")}
        aria-busy={result.isFetching}
      >
        <div className="explore__panel">
          {timeRange === null ? null : (
            <PanelHostContext value={{ orgId }}>
              <PanelBody
                panel={panel}
                title={analysis.title}
                range={timeRange}
                pending={result.isPending}
                error={result.error}
                onRetry={() => void result.refetch()}
                fetching={result.isFetching}
                outcomes={result.data ?? []}
                revision={String(result.dataUpdatedAt)}
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
    </div>
  );
}
