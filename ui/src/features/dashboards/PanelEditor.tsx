import { useQuery } from "@tanstack/react-query";
import {
  type ComponentProps,
  type FocusEvent,
  memo,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useCallback,
  useDeferredValue,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { namedInputs, runPanelSteps } from "../../analysis/panel";
import { StepsEditor } from "../../analysis/StepsEditor";
import { asSteps, withUnknown } from "../../analysis/steps";
import type { Shape, TimeRange } from "../../api/generated/shapes";
import { Breadcrumbs, type Crumb } from "../../components/Breadcrumbs";
import { Icon } from "../../components/Icon";
import { Splitter } from "../../components/Splitter";
import { ProjectionEditor } from "../../documents/ProjectionEditor";
import {
  type FrameProjection,
  hasProjectionProblems,
  projectionApplies,
  projectionFor,
  projectionPaths,
  storableTransformations,
  withProjection,
} from "../../documents/projection";
import { schemaOf } from "../../documents/schema";
import { useI18n } from "../../i18n/i18n";
import { openLayerCount } from "../../lib/layers";
import { useOrgPermissions } from "../../org/useOrg";
import { FieldConfigEditor } from "../../panels/fieldConfig/FieldConfigEditor";
import { upgradePanel } from "../../panels/fieldConfig/upgrade";
import { PanelPicker } from "../../panels/picker/PanelPicker";
import { getPanel } from "../../panels/registry";
import { useStyleVars } from "../../panels/styleVars";
import { useElementSize } from "../../panels/useElementSize";
import { datasourcesQuery, kindsQuery, sourceAccess } from "../datasources/api";
import type { PreviewRun } from "../datasources/editors/MongoQueryEditor";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { addMatch, isMongoQuery, parseMongoQuery } from "../datasources/mongoQuery";
import { emptyQuery, queryText } from "../datasources/queryKinds";
import { type EditorLayout, readEditorLayout, writeEditorLayout } from "./editorLayout";
import {
  nextRefId,
  type PanelModel,
  type RowModel,
  type Target,
  type VariableModel,
  type VariableValues,
  variableTexts,
} from "./model";
import { PanelBody } from "./PanelCard";
import { PanelExtras, panelExtrasProblem } from "./PanelExtras";
import { documentsOf } from "./results";
import { usePanelResults } from "./usePanelResults";
import "./panelEditor.css";

/** What the dashboard reads from the open editor when it is left another way than Discard. */
export interface EditorSnapshot {
  id: string;
  /** The panel as edited: look, queries and steps together. */
  panel: () => PanelModel;
  /** Whether anything differs from the panel the editor opened with. */
  changed: () => boolean;
}

interface PanelEditorProps {
  orgId: string;
  dashboardId: string;
  /** Splits are remembered per account. */
  userId: string;
  panel: PanelModel;
  range: TimeRange;
  variables: VariableValues;
  /** The panel as saved, absent for a new one; unchanged targets preview through its route. */
  stored?: PanelModel | undefined;
  /** The saved dashboard's variables, for the panel route. */
  savedVariables?: readonly VariableModel[];
  /** The trail up to the dashboard; the editor adds itself as the last crumb. */
  crumbs: readonly Crumb[];
  /** Called with the editor's state as it changes, so leaving by any route keeps the change. */
  onSnapshot: (snapshot: EditorSnapshot) => void;
  /** Back to the dashboard with the change in the draft (Esc does the same). */
  onBack: () => void;
  /** Back to the dashboard with the panel as it was. */
  onDiscard: () => void;
  /** Puts the change into the draft and asks for the save message. */
  onSave: (panel: PanelModel) => void;
  /** The dashboard's rows and variables, for the panel's place and repeat. */
  rows?: readonly RowModel[];
  dashboardVariables?: readonly VariableModel[];
  /** The library panel this one shows, by name. */
  libraryName?: string | undefined;
  /** Turns the edited panel into a library panel. */
  onMakeLibrary?: ((panel: PanelModel) => void) | undefined;
}

type LowerTab = "queries" | "steps";
const LOWER_TABS: readonly LowerTab[] = ["queries", "steps"];

/**
 * Edits one panel on a page of its own: the preview on top, its queries and steps in tabs below,
 * the options on the right. State is split so typing stays cheap (docs/design/feel.md section
 * 10): the look (title, type, options and the rest), the queries and the steps are kept apart;
 * the preview draws a memoized panel made of the look and the queries last run; each query
 * editor gets callbacks that never change, so a key press renders that editor only. Queries run
 * on Ctrl+Enter, the run button, or when focus leaves a changed query.
 */
export function PanelEditor({
  orgId,
  dashboardId,
  userId,
  panel: initial,
  range,
  variables,
  stored,
  savedVariables = [],
  crumbs,
  onSnapshot,
  onBack,
  onDiscard,
  onSave,
  rows = [],
  dashboardVariables = [],
  libraryName,
  onMakeLibrary,
}: PanelEditorProps) {
  const { t } = useI18n();
  const titleId = useId();
  const permissions = useOrgPermissions();
  // Panels saved before the field options existed move their old options to the new place.
  const [opened] = useState(() => upgradePanel(initial));
  // The look: everything but the queries and steps, whose copies in it are not read.
  const [look, setLook] = useState(opened);
  const [targets, setTargets] = useState(opened.targets);
  const [steps, setSteps] = useState(opened.transformations);
  // Options per panel type seen in this editor, so arrowing through the picker and back to a
  // type keeps what was set for it.
  const optionsByType = useRef<Record<string, unknown>>({});
  // The preview runs what was last run, not every keystroke.
  const [preview, setPreview] = useState({ targets: opened.targets, run: 0 });
  const [tab, setTab] = useState<LowerTab>("queries");
  const [problem, setProblem] = useState(false);
  // A click-to-filter the editor could not add, until the next run or source change.
  const [filterError, setFilterError] = useState<string | null>(null);
  // Per query: whether its editor holds text that does not parse yet.
  const pendingText = useRef<Record<string, boolean>>({});
  const targetsRef = useRef(targets);
  const previewRef = useRef(preview.targets);
  // The range and values a pipeline stage previews with, read when a preview runs.
  const runInput = useRef<PreviewRun>({ range, variables });
  useEffect(() => {
    runInput.current = { range, variables };
  });

  // As the dashboard stores it: projection steps that would change nothing are left out.
  const compose = useCallback(
    (): PanelModel => ({ ...look, targets, transformations: storableTransformations(steps) }),
    [look, targets, steps],
  );
  const latest = useRef(compose);
  useEffect(() => {
    targetsRef.current = targets;
    previewRef.current = preview.targets;
    latest.current = compose;
    onSnapshot({
      id: opened.id,
      panel: compose,
      changed: () =>
        JSON.stringify(compose()) !==
        JSON.stringify({
          ...opened,
          transformations: storableTransformations(opened.transformations),
        }),
    });
  }, [onSnapshot, opened, compose, targets, preview.targets]);

  const datasources = useQuery(datasourcesQuery(orgId));
  const kinds = useQuery(kindsQuery(orgId));
  // Free queries need query rights on the source (the role or a grant); without them a panel
  // can still be renamed, rearranged and restyled, and its saved queries preview as viewers see
  // them, through the panel route.
  const queryable = useMemo(
    () =>
      (datasources.data ?? []).filter((source) => sourceAccess(source.access, permissions).query),
    [datasources.data, permissions],
  );
  const mayQuery = permissions.has("datasources:query") || queryable.length > 0;
  const unchanged = useMemo(
    () =>
      stored !== undefined && JSON.stringify(preview.targets) === JSON.stringify(stored.targets),
    [stored, preview.targets],
  );

  // The steps run a moment behind typing; the preview and the steps editor share one run.
  const deferredSteps = useDeferredValue(steps);
  // Only what the drawing reads: typing a title or a link leaves the preview alone.
  const { id, type, options, fieldConfig, grid } = look;
  const previewPanel = useMemo(
    (): PanelModel => ({
      id,
      type,
      title: "",
      grid,
      targets: preview.targets,
      transformations: deferredSteps,
      options,
      fieldConfig,
    }),
    [id, type, grid, preview.targets, deferredSteps, options, fieldConfig],
  );
  const results = usePanelResults({
    orgId,
    dashboardId,
    panel: previewPanel,
    range,
    variables,
    saved: savedVariables,
    source: unchanged ? "stored" : "draft",
    run: preview.run,
  });
  const outcomes = useMemo(() => results.data ?? [], [results.data]);
  const stepsRun = useMemo(() => runPanelSteps(deferredSteps, outcomes), [deferredSteps, outcomes]);
  const inputs = useMemo(() => namedInputs(outcomes), [outcomes]);
  const texts = useMemo(() => variableTexts(variables), [variables]);

  // Which sources the queries use, as one string: typing a query leaves it equal.
  const sourceKey = targets.map((target) => target.datasourceId).join("\n");
  const refKey = targets.map((target) => target.refId).join("\n");
  const refIds = useMemo(() => (refKey === "" ? [] : refKey.split("\n")), [refKey]);
  // What the preview returned decides which panels fit; before it ran, what the sources can return.
  // An applied projection step turns that query's documents into a frame.
  const shapes = useMemo((): Shape[] => {
    const projected = (refId: string) => {
      const step = projectionFor(steps, refId);
      return step !== undefined && projectionApplies(step);
    };
    const returned = outcomes.flatMap((o): Shape[] =>
      "result" in o
        ? o.result.shape === "documents" && projected(o.refId)
          ? ["documents", "frame"]
          : [o.result.shape]
        : [],
    );
    const kindOf = (datasourceId: string) =>
      datasources.data?.find((d) => d.id === datasourceId)?.kind;
    const sources = sourceKey.split("\n");
    return [
      ...new Set(
        returned.length > 0
          ? returned
          : refKey.split("\n").flatMap((refId, index): Shape[] => {
              const kindShapes =
                kinds.data?.find((k) => k.kind === kindOf(sources[index] ?? ""))?.shapes ?? [];
              return projected(refId) ? [...kindShapes, "frame"] : kindShapes;
            }),
      ),
    ];
  }, [outcomes, sourceKey, refKey, steps, datasources.data, kinds.data]);
  // Field paths per query from the last preview, suggested for its projection.
  const fieldsByRef = useMemo(() => {
    const byRef = new Map<string, string[]>();
    for (const d of documentsOf(outcomes)) {
      const paths = projectionPaths(schemaOf(d.documents));
      byRef.set(d.refId, [...new Set([...(byRef.get(d.refId) ?? []), ...paths])]);
    }
    return byRef;
  }, [outcomes]);

  // A new run, or another data source, leaves an old filter refusal behind.
  const run = useCallback(() => {
    setFilterError(null);
    setPreview((current) => ({ targets: targetsRef.current, run: current.run + 1 }));
  }, []);
  const changeTarget = useCallback((refId: string, patch: Partial<Target>) => {
    if (patch.datasourceId !== undefined) {
      setFilterError(null);
    }
    setTargets((list) =>
      list.map((target) => (target.refId === refId ? { ...target, ...patch } : target)),
    );
  }, []);
  const removeTarget = useCallback((refId: string) => {
    setTargets((list) => list.filter((x) => x.refId !== refId));
    setSteps((current) => withProjection(current, refId, undefined));
  }, []);
  const changeProjection = useCallback(
    (refId: string, projection: FrameProjection | undefined) =>
      setSteps((current) => withProjection(current, refId, projection)),
    [],
  );
  const markPending = useCallback((refId: string, pending: boolean) => {
    pendingText.current = { ...pendingText.current, [refId]: pending };
  }, []);
  const previewRun = useCallback(() => runInput.current, []);

  /** Click-to-filter in the preview: a `$match` stage on that query, run at once. */
  const filterBy = useCallback(
    (refId: string, path: string, value: unknown) => {
      // The filter joins the query in the editor, the draft typed since included; text that
      // does not parse, in the query or still in a field, is never replaced.
      const draft = targetsRef.current.find((target) => target.refId === refId);
      if (draft === undefined || !isMongoQuery(draft.query)) {
        return;
      }
      if (pendingText.current[refId] === true) {
        setFilterError(t("documents.filter.refused.draft"));
        return;
      }
      const added = addMatch(parseMongoQuery(draft.query), path, value);
      if ("refused" in added) {
        setFilterError(t(`documents.filter.refused.${added.refused}`));
        return;
      }
      setFilterError(null);
      const next = targetsRef.current.map((target) =>
        target.refId === refId ? { ...target, query: added.query } : target,
      );
      targetsRef.current = next;
      setTargets(next);
      setPreview((current) => ({ targets: next, run: current.run + 1 }));
    },
    [t],
  );
  const filterable = preview.targets.some((target) => isMongoQuery(target.query));
  // A projection step the server would refuse is fixed here before the panel goes back.
  const blocked = hasProjectionProblems(steps);
  // Leaving a query that changed since the last run runs it, as Ctrl+Enter would.
  const runIfChanged = useCallback(() => {
    if (JSON.stringify(targetsRef.current) !== JSON.stringify(previewRef.current)) {
      run();
    }
  }, [run]);

  const addTarget = useCallback(() => {
    const first = queryable[0];
    const kindOf = (datasourceId: string) =>
      datasources.data?.find((d) => d.id === datasourceId)?.kind;
    setTargets((list) => [
      ...list,
      {
        refId: nextRefId(list),
        datasourceId: list.at(-1)?.datasourceId ?? first?.id ?? "",
        query: emptyQuery(kindOf(list.at(-1)?.datasourceId ?? "") ?? first?.kind ?? ""),
      },
    ]);
  }, [queryable, datasources.data]);
  const changeSteps = useCallback(
    (next: ReturnType<typeof asSteps>) => setSteps((current) => withUnknown(current, next)),
    [],
  );
  // Switching the type keeps the old type's options for a way back.
  const changeType = useCallback(
    (next: string) =>
      setLook((p) => {
        optionsByType.current = { ...optionsByType.current, [p.type]: p.options };
        return { ...p, type: next, options: optionsByType.current[next] ?? {} };
      }),
    [],
  );
  const makeLibrary = useMemo(
    () => (onMakeLibrary === undefined ? undefined : () => onMakeLibrary(latest.current())),
    [onMakeLibrary],
  );
  const pending = results.isPending && results.fetchStatus !== "idle";

  function back() {
    if (blocked || panelExtrasProblem(look) !== null) {
      setProblem(true);
      return;
    }
    onBack();
  }
  const backRef = useRef(back);
  useEffect(() => {
    backRef.current = back;
  });
  // Esc goes back, unless something inside took it first (a completion list, a menu, a dialog,
  // the chart's readout): those stop the event or hold an escape layer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        !event.defaultPrevented &&
        !event.isComposing &&
        openLayerCount() === 0
      ) {
        event.preventDefault();
        backRef.current();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  const stepCount = asSteps(steps).length;
  const lower = (
    <LowerPane
      idPrefix={titleId}
      tab={tab}
      onTab={setTab}
      counts={{ queries: targets.length, steps: stepCount }}
      queries={
        <TargetList
          orgId={orgId}
          targets={targets}
          queryable={queryable}
          mayQuery={mayQuery}
          noSources={mayQuery && datasources.data?.length === 0}
          canAdd={datasources.data !== undefined && queryable.length > 0}
          onAdd={addTarget}
          onChange={changeTarget}
          onRemove={removeTarget}
          onRun={run}
          onLeave={runIfChanged}
          steps={steps}
          fields={fieldsByRef}
          onProjection={changeProjection}
          onPendingText={markPending}
          previewRun={previewRun}
        />
      }
      steps={
        <StepsTab
          steps={steps}
          onChange={changeSteps}
          refIds={refIds}
          inputs={inputs}
          run={stepsRun}
        />
      }
    />
  );

  const previewSection = (
    <EditorPreview
      notice={filterError}
      revision={results.dataUpdatedAt}
      onFilter={filterable ? filterBy : undefined}
      panel={previewPanel}
      title={look.title}
      range={range}
      pending={pending}
      error={results.error}
      outcomes={outcomes}
      stepsRun={stepsRun}
      variables={texts}
    />
  );

  const optionsPane = (
    <OptionsPane
      titleId={titleId}
      look={look}
      shapes={shapes}
      rows={rows}
      variables={dashboardVariables}
      libraryName={look.libraryPanelId === undefined ? undefined : libraryName}
      onLook={setLook}
      onType={changeType}
      onMakeLibrary={makeLibrary}
    />
  );

  const editorTitle = t("dashboards.editor.title");
  return (
    <section className="panel-editor" aria-label={editorTitle}>
      <Breadcrumbs crumbs={[...crumbs, { label: editorTitle }]} />
      <div className="panel-editor__bar">
        <button
          type="button"
          className="button button--secondary panel-editor__back"
          onClick={back}
          title={t("dashboards.editor.backHint")}
        >
          <Icon name="chevron" className="panel-editor__back-icon" />
          {t("dashboards.editor.back")}
        </button>
        <h1 className="panel-editor__title truncate" id={titleId}>
          {editorTitle}
          <span className="panel-editor__name">
            {look.title === "" ? t("dashboards.panel.untitled") : look.title}
          </span>
        </h1>
        <div className="panel-editor__actions">
          <button type="button" className="button button--secondary" onClick={onDiscard}>
            {t("dashboards.editor.discard")}
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => onSave(compose())}
            disabled={blocked || panelExtrasProblem(look) !== null}
            aria-describedby={blocked ? `${titleId}-blocked` : undefined}
          >
            {t("dashboards.save")}
          </button>
        </div>
      </div>
      {blocked ? (
        <p className="field__error" id={`${titleId}-blocked`}>
          {t("documents.projection.blocked")}
        </p>
      ) : null}
      {problem && panelExtrasProblem(look) !== null ? (
        <p className="field__error" role="alert">
          {t("dashboards.editor.problem")}
        </p>
      ) : null}
      <EditorSplits
        userId={userId}
        idPrefix={titleId}
        preview={previewSection}
        lower={lower}
        options={optionsPane}
      />
    </section>
  );
}

/** The preview: the panel's drawing, memoized so typing a query or an option label skips it. */
const EditorPreview = memo(function EditorPreview({
  notice,
  ...props
}: ComponentProps<typeof PanelBody> & { notice: string | null }) {
  const { t } = useI18n();
  return (
    <section className="panel-editor__preview" aria-label={t("dashboards.editor.preview")}>
      {notice === null ? null : (
        <p className="field__error" role="alert">
          {notice}
        </p>
      )}
      <div className="panel-editor__viz">
        <PanelBody {...props} />
      </div>
    </section>
  );
});

/** The steps tab, memoized: typing a query leaves the steps and their previews alone. */
const StepsTab = memo(function StepsTab({
  steps,
  onChange,
  refIds,
  inputs,
  run,
}: {
  steps: unknown[];
  onChange: (steps: ReturnType<typeof asSteps>) => void;
  refIds: readonly string[];
  inputs: ComponentProps<typeof StepsEditor>["inputs"];
  run: ComponentProps<typeof StepsEditor>["run"];
}) {
  const list = useMemo(() => asSteps(steps), [steps]);
  return <StepsEditor steps={list} onChange={onChange} refIds={refIds} inputs={inputs} run={run} />;
});

/** Bounds of the splits in px. */
const OPTIONS_MIN = 240;
const OPTIONS_MAX = 640;
const OPTIONS_DEFAULT = 330;
const PREVIEW_MIN = 160;
const LOWER_MIN = 160;

/**
 * The editor's three panes with their separators. Sizes live here, apart from the editor's
 * state, so dragging a separator renders this frame only; the panes are passed in as elements
 * that keep their identity and are skipped.
 */
function EditorSplits({
  userId,
  idPrefix,
  preview,
  lower,
  options,
}: {
  userId: string;
  idPrefix: string;
  preview: ReactNode;
  lower: ReactNode;
  options: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDivElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<EditorLayout>(() => readEditorLayout(userId));
  const { height } = useElementSize(mainRef);
  const previewMax = Math.max(PREVIEW_MIN, height - LOWER_MIN);
  const previewHeight = Math.min(Math.max(layout.preview ?? height / 2, PREVIEW_MIN), previewMax);
  const optionsWidth = layout.options ?? OPTIONS_DEFAULT;
  const collapsed = layout.collapsed === true;
  const vars: Record<string, string> = { "--editor-options": `${optionsWidth}px` };
  if (layout.preview !== undefined) vars["--editor-preview"] = `${previewHeight}px`;
  useStyleVars(ref, vars);

  function keep(next: EditorLayout) {
    setLayout(next);
    writeEditorLayout(userId, next);
  }
  const set = (name: string, px: number) => ref.current?.style.setProperty(name, `${px}px`);

  return (
    <div
      ref={ref}
      className={collapsed ? "editor-splits editor-splits--collapsed" : "editor-splits"}
    >
      <div className="editor-splits__main" ref={mainRef}>
        <div className="editor-splits__preview" id={`${idPrefix}-preview`}>
          {preview}
        </div>
        <Splitter
          orientation="horizontal"
          label={t("dashboards.editor.resizePreview")}
          controls={`${idPrefix}-preview`}
          value={previewHeight}
          min={PREVIEW_MIN}
          max={previewMax}
          onPreview={(px) => set("--editor-preview", px)}
          onChange={(px) => keep({ ...layout, preview: px })}
        />
        <div className="editor-splits__lower">{lower}</div>
      </div>
      {collapsed ? null : (
        <Splitter
          orientation="vertical"
          label={t("dashboards.editor.resizeOptions")}
          controls={`${idPrefix}-options`}
          value={optionsWidth}
          min={OPTIONS_MIN}
          max={OPTIONS_MAX}
          direction={-1}
          onPreview={(px) => set("--editor-options", px)}
          onChange={(px) => keep({ ...layout, options: px })}
        />
      )}
      <section
        className="editor-splits__options"
        id={`${idPrefix}-options`}
        aria-labelledby={`${idPrefix}-options-heading`}
      >
        <div className="options-pane__header">
          <h2 className="options-pane__heading" id={`${idPrefix}-options-heading`}>
            {t("dashboards.editor.options")}
          </h2>
          <button
            type="button"
            className="button button--ghost button--small options-pane__toggle"
            aria-expanded={!collapsed}
            aria-controls={`${idPrefix}-options-body`}
            onClick={() => keep({ ...layout, collapsed: !collapsed })}
            title={
              collapsed ? t("dashboards.editor.showOptions") : t("dashboards.editor.hideOptions")
            }
            aria-label={
              collapsed ? t("dashboards.editor.showOptions") : t("dashboards.editor.hideOptions")
            }
          >
            <Icon name="sidebar" />
          </button>
        </div>
        <div className="options-pane__body" id={`${idPrefix}-options-body`} hidden={collapsed}>
          {options}
        </div>
      </section>
    </div>
  );
}

/** The lower pane: tabs for the queries and the steps, each with its count. */
function LowerPane({
  idPrefix,
  tab,
  onTab,
  counts,
  queries,
  steps,
}: {
  idPrefix: string;
  tab: LowerTab;
  onTab: (tab: LowerTab) => void;
  counts: Record<LowerTab, number>;
  queries: ReactNode;
  steps: ReactNode;
}) {
  const { t } = useI18n();
  const labels: Record<LowerTab, string> = {
    queries: t("dashboards.editor.queries"),
    steps: t("analysis.steps.title"),
  };
  function onKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") {
      return;
    }
    event.preventDefault();
    const index = LOWER_TABS.indexOf(tab);
    const next =
      LOWER_TABS[(index + (event.key === "ArrowRight" ? 1 : LOWER_TABS.length - 1)) % 2] ??
      "queries";
    onTab(next);
    document.getElementById(`${idPrefix}-${next}-tab`)?.focus();
  }
  return (
    <div className="lower-pane">
      <div
        className="tabs lower-pane__tabs"
        role="tablist"
        aria-label={t("dashboards.editor.dataTabs")}
        onKeyDown={onKeyDown}
      >
        {LOWER_TABS.map((name) => (
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
            {labels[name]} <span className="tabs__count">{counts[name]}</span>
          </button>
        ))}
      </div>
      {/* Both stay mounted, so switching tabs keeps the query editors and their undo history. */}
      <div
        className="lower-pane__panel"
        role="tabpanel"
        id={`${idPrefix}-queries`}
        aria-labelledby={`${idPrefix}-queries-tab`}
        hidden={tab !== "queries"}
      >
        {queries}
      </div>
      <div
        className="lower-pane__panel"
        role="tabpanel"
        id={`${idPrefix}-steps`}
        aria-labelledby={`${idPrefix}-steps-tab`}
        hidden={tab !== "steps"}
      >
        {steps}
      </div>
    </div>
  );
}

/** The options pane: title, visualization, the panel's and the fields' options, the rest. */
const OptionsPane = memo(function OptionsPane({
  titleId,
  look,
  shapes,
  rows,
  variables,
  libraryName,
  onLook,
  onType,
  onMakeLibrary,
}: {
  titleId: string;
  look: PanelModel;
  shapes: readonly Shape[];
  rows: readonly RowModel[];
  variables: readonly VariableModel[];
  libraryName: string | undefined;
  onLook: (change: (panel: PanelModel) => PanelModel) => void;
  onType: (type: string) => void;
  onMakeLibrary: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const plugin = getPanel(look.type);
  const Editor = plugin?.Editor;
  return (
    <div className="options-pane">
      <div className="field">
        <label className="field__label" htmlFor={`${titleId}-title`}>
          {t("dashboards.editor.panelTitle")}
        </label>
        <input
          id={`${titleId}-title`}
          className="input"
          value={look.title}
          onChange={(event) => {
            const title = event.currentTarget.value;
            onLook((p) => ({ ...p, title }));
          }}
        />
      </div>
      <PanelPicker value={look.type} shapes={shapes} onChange={onType} />
      {plugin === undefined || Editor === undefined ? null : (
        <fieldset className="panel-editor__options">
          <legend className="field__label">{t("dashboards.editor.panelOptions")}</legend>
          <Editor
            options={plugin.options(look.options)}
            onChange={(options: unknown) => onLook((p) => ({ ...p, options }))}
          />
        </fieldset>
      )}
      {plugin?.fieldOptions === undefined ? null : (
        <fieldset className="panel-editor__options">
          <legend className="field__label">{t("panels.fieldOptions")}</legend>
          <FieldConfigEditor
            value={look.fieldConfig}
            groups={plugin.fieldOptions}
            onChange={(fieldConfig) => onLook((p) => ({ ...p, fieldConfig }))}
          />
        </fieldset>
      )}
      <PanelExtras
        panel={look}
        onChange={onLook}
        rows={rows}
        variables={variables}
        libraryName={libraryName}
        onMakeLibrary={onMakeLibrary}
      />
    </div>
  );
});

/** The queries tab: one editor per target, the run button and adding a query. */
function TargetList({
  orgId,
  targets,
  queryable,
  mayQuery,
  noSources,
  canAdd,
  onAdd,
  onChange,
  onRemove,
  onRun,
  onLeave,
  steps,
  fields,
  onProjection,
  onPendingText,
  previewRun,
}: {
  orgId: string;
  targets: readonly Target[];
  queryable: readonly { id: string; name: string; kind: string }[];
  mayQuery: boolean;
  noSources: boolean;
  canAdd: boolean;
  onAdd: () => void;
  onChange: (refId: string, patch: Partial<Target>) => void;
  onRemove: (refId: string) => void;
  onRun: () => void;
  onLeave: () => void;
  /** The panel's steps, for each document query's projection step. */
  steps: readonly unknown[];
  /** Field paths of the last preview per query, to suggest for its projection. */
  fields: ReadonlyMap<string, readonly string[]>;
  onProjection: (refId: string, projection: FrameProjection | undefined) => void;
  onPendingText: (refId: string, pending: boolean) => void;
  previewRun: () => PreviewRun;
}) {
  const { t } = useI18n();
  return (
    <div className="panel-editor__queries">
      <div className="panel-editor__queries-header">
        {mayQuery ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onAdd}
            disabled={!canAdd}
          >
            <Icon name="plus" />
            {t("dashboards.editor.addQuery")}
          </button>
        ) : null}
        <button type="button" className="button button--secondary button--small" onClick={onRun}>
          {t("dashboards.editor.run")}
        </button>
      </div>
      {targets.map((target) => (
        <TargetEditor
          key={target.refId}
          orgId={orgId}
          target={target}
          datasources={queryable}
          readOnly={!queryable.some((source) => source.id === target.datasourceId)}
          onChange={onChange}
          onRemove={onRemove}
          onRun={onRun}
          onLeave={onLeave}
          projection={projectionFor(steps, target.refId)}
          fields={fields.get(target.refId) ?? NO_FIELDS}
          onProjection={onProjection}
          onPendingText={onPendingText}
          previewRun={previewRun}
        />
      ))}
      {noSources ? <p className="field__hint">{t("dashboards.editor.noDatasources")}</p> : null}
      {mayQuery ? null : <p className="field__hint">{t("dashboards.editor.noQueryRight")}</p>}
    </div>
  );
}

const NO_FIELDS: readonly string[] = [];

/**
 * One query. Memoized with callbacks that take the refId, so typing in one query renders that
 * query's editor and nothing else.
 */
const TargetEditor = memo(function TargetEditor({
  orgId,
  target,
  datasources,
  readOnly,
  onChange,
  onRemove,
  onRun,
  onLeave,
  projection,
  fields,
  onProjection,
  onPendingText,
  previewRun,
}: {
  orgId: string;
  target: Target;
  /** The projection step of this query, stored with the panel. */
  projection: FrameProjection | undefined;
  /** Field paths of the last preview, to suggest for the projection. */
  fields: readonly string[];
  onProjection: (refId: string, projection: FrameProjection | undefined) => void;
  onPendingText: (refId: string, pending: boolean) => void;
  /** The dashboard's time range and variables, for stage previews. */
  previewRun: () => PreviewRun;
  /** The sources the caller may query, to pick from. */
  datasources: readonly { id: string; name: string; kind: string }[];
  /** The target's source is not one of them: the query shows as stored and stays as it is. */
  readOnly: boolean;
  onChange: (refId: string, patch: Partial<Target>) => void;
  onRemove: (refId: string) => void;
  onRun: () => void;
  /** Focus left the query. */
  onLeave: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const datasource = datasources.find((d) => d.id === target.datasourceId);
  const { refId } = target;
  if (readOnly && target.datasourceId !== "") {
    return (
      <section className="target" aria-label={t("dashboards.inspect.query", { refId })}>
        <div className="target__header">
          <span className="target__ref">{refId}</span>
          <button
            type="button"
            className="button button--ghost button--small"
            onClick={() => onRemove(refId)}
            aria-label={t("dashboards.editor.removeQuery", { refId })}
          >
            {t("dashboards.editor.remove")}
          </button>
        </div>
        <pre className="target__stored">{queryText(target.query)}</pre>
        <p className="field__hint">{t("dashboards.editor.readOnlyQuery")}</p>
      </section>
    );
  }
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    const next = event.relatedTarget;
    if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
      onLeave();
    }
  };
  return (
    <section
      className="target"
      aria-label={t("dashboards.inspect.query", { refId })}
      onBlur={onBlur}
    >
      <div className="target__header">
        <span className="target__ref">{refId}</span>
        <label className="visually-hidden" htmlFor={id}>
          {t("dashboards.editor.datasource")}
        </label>
        <select
          id={id}
          className="select"
          value={target.datasourceId}
          onChange={(event) => {
            const next = datasources.find((d) => d.id === event.currentTarget.value);
            // Another kind means another query form; the old text would not fit it.
            onChange(
              refId,
              next !== undefined && next.kind !== datasource?.kind
                ? { datasourceId: next.id, query: emptyQuery(next.kind) }
                : { datasourceId: event.currentTarget.value },
            );
          }}
        >
          {datasource === undefined ? (
            <option value="">{t("dashboards.editor.pickDatasource")}</option>
          ) : null}
          {datasources.map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={() => onRemove(refId)}
          aria-label={t("dashboards.editor.removeQuery", { refId })}
        >
          {t("dashboards.editor.remove")}
        </button>
      </div>
      {datasource === undefined ? null : (
        <QueryEditor
          orgId={orgId}
          datasource={datasource}
          query={target.query}
          onChange={(query) => onChange(refId, { query })}
          onRun={onRun}
          previewRun={previewRun}
          onPendingText={(pending) => onPendingText(refId, pending)}
          label={t("dashboards.inspect.query", { refId })}
        />
      )}
      {datasource !== undefined && isMongoQuery(target.query) ? (
        <ProjectionEditor
          projection={projection}
          fields={fields}
          onChange={(next) => onProjection(refId, next)}
        />
      ) : null}
    </section>
  );
});
