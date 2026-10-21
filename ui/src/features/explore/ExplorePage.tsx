import { useQuery } from "@tanstack/react-query";
import { type KeyboardEvent, useId, useRef, useState } from "react";
import { EmptyState } from "../../components/EmptyState";
import { FormAlert } from "../../components/FormAlert";
import { Page } from "../../components/Page";
import { useI18n } from "../../i18n/i18n";
import { readPreference, writePreference } from "../../lib/storage";
import { useDocumentTitle } from "../../lib/useDocumentTitle";
import { useCurrentOrg, useOrgPermissions } from "../../org/useOrg";
import { panelsForShapes, suggestPanel } from "../../panels/registry";
import { PanelBody } from "../dashboards/PanelCard";
import type { PanelModel } from "../dashboards/model";
import { outcomesOf } from "../dashboards/results";
import { TimeRangePicker } from "../dashboards/TimeRangePicker";
import {
  intervalFor,
  MAX_DATA_POINTS,
  resolveRange,
  type TextRange,
} from "../dashboards/timeRange";
import { errorMessage } from "../dashboards/ui/errors";
import { Inspect } from "../dashboards/ui/Inspect";
import { datasourcesQuery, kindsQuery, runQuery } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { emptyQuery, queryText } from "../datasources/queryKinds";
import { AddToDashboardDialog } from "./AddToDashboardDialog";
import "./explore.css";

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
  let body = null;
  if (org !== undefined && permissions.has("datasources:query")) {
    body = <Explore orgId={org.id} />;
  } else if (permissions.loaded) {
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
  const [range, setRange] = useState<TextRange>({ from: "now-1h", to: "now" });
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [rangeError, setRangeError] = useState<string | null>(null);
  const [panelType, setPanelType] = useState<string | null>(null);
  const [tab, setTab] = useState<"result" | "inspect">("result");
  const [adding, setAdding] = useState(false);
  const tabsId = useId();

  const list = datasources.data ?? [];
  const datasource = list.find((d) => d.id === chosen) ?? list[0];
  const query =
    datasource === undefined ? null : (queries[datasource.id] ?? emptyQuery(datasource.kind));

  const result = useQuery({
    queryKey: ["explore", orgId, submitted],
    enabled: submitted !== null,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
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

  function run(nextRange = range) {
    if (datasource === undefined || query === null || queryText(query).trim() === "") {
      return;
    }
    const resolved = resolveRange(nextRange, Date.now());
    if (!resolved.ok) {
      setRangeError(t(`dashboards.time.error.${resolved.error}`));
      return;
    }
    setRangeError(null);
    setSubmitted((current) => ({
      datasourceId: datasource.id,
      query,
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

  const outcomes = result.data ?? [];
  const results = outcomes.flatMap((o) => ("result" in o ? [o.result] : []));
  const shapes = kinds.data?.find((k) => k.kind === datasource.kind)?.shapes ?? ["frame"];
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
    transformations: [],
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
      <QueryEditor
        key={datasource.id}
        orgId={orgId}
        datasource={datasource}
        query={query}
        onChange={(next) => setQueries((current) => ({ ...current, [datasource.id]: next }))}
        onRun={() => run()}
      />
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
                disabled={result.data === undefined}
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
                hasTargets
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
        </section>
      )}
      {adding && submitted !== null ? (
        <AddToDashboardDialog
          orgId={orgId}
          panel={{ ...panel, title: datasource.name }}
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
