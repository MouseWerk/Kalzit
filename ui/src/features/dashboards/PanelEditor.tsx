import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { namedInputs, runPanelSteps } from "../../analysis/panel";
import { StepsEditor } from "../../analysis/StepsEditor";
import { asSteps, withUnknown } from "../../analysis/steps";
import type { Shape, TimeRange } from "../../api/generated/shapes";
import { ProjectionEditor } from "../../documents/ProjectionEditor";
import {
  type FrameProjection,
  hasProjectionProblems,
  projectionFor,
  projectionPaths,
  storableTransformations,
  withProjection,
} from "../../documents/projection";
import { schemaOf } from "../../documents/schema";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import { FieldConfigEditor } from "../../panels/fieldConfig/FieldConfigEditor";
import { upgradePanel } from "../../panels/fieldConfig/upgrade";
import { PanelPicker } from "../../panels/picker/PanelPicker";
import { getPanel } from "../../panels/registry";
import { datasourcesQuery, kindsQuery, sourceAccess } from "../datasources/api";
import type { PreviewRun } from "../datasources/editors/MongoQueryEditor";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { addMatch, isMongoQuery, parseMongoQuery } from "../datasources/mongoQuery";
import { emptyQuery, queryText } from "../datasources/queryKinds";
import { nextRefId, type PanelModel, type Target, type VariableModel } from "./model";
import { PanelBody } from "./PanelCard";
import { documentsOf } from "./results";
import { Dialog } from "./ui/Dialog";
import { usePanelResults } from "./usePanelResults";

interface PanelEditorProps {
  orgId: string;
  dashboardId: string;
  panel: PanelModel;
  range: TimeRange;
  variables: Record<string, string>;
  /** The panel as saved, absent for a new one; unchanged targets preview through its route. */
  stored?: PanelModel | undefined;
  /** The saved dashboard's variables, for the panel route. */
  savedVariables?: readonly VariableModel[];
  onApply: (panel: PanelModel) => void;
  onClose: () => void;
}

/** Edits one panel: its queries, the visualization and its options, with a live preview. */
export function PanelEditor({
  orgId,
  dashboardId,
  panel: initial,
  range,
  variables,
  stored,
  savedVariables = [],
  onApply,
  onClose,
}: PanelEditorProps) {
  const { t } = useI18n();
  const titleId = useId();
  const permissions = useOrgPermissions();
  // Panels saved before the field options existed move their old options to the new place.
  const [panel, setPanel] = useState(() => upgradePanel(initial));
  // Options per panel type seen in this editor, so arrowing through the picker and back to a
  // type keeps what was set for it.
  const [optionsByType, setOptionsByType] = useState<Record<string, unknown>>({});
  const [filterError, setFilterError] = useState<string | null>(null);
  // Per query: whether its editor holds text that does not parse yet.
  const [pendingText, setPendingText] = useState<Record<string, boolean>>({});
  // The preview runs what was last run, not every keystroke.
  const [preview, setPreview] = useState({ targets: initial.targets, run: 0 });
  const datasources = useQuery(datasourcesQuery(orgId));
  const kinds = useQuery(kindsQuery(orgId));
  // Free queries need query rights on the source (the role or a grant); without them a panel
  // can still be renamed, rearranged and restyled, and its saved queries preview as viewers see
  // them, through the panel route.
  const queryable = (datasources.data ?? []).filter(
    (source) => sourceAccess(source.access, permissions).query,
  );
  const mayQuery = permissions.has("datasources:query") || queryable.length > 0;
  const unchanged =
    stored !== undefined && JSON.stringify(preview.targets) === JSON.stringify(stored.targets);
  const results = usePanelResults({
    orgId,
    dashboardId,
    panel: { ...panel, targets: preview.targets },
    range,
    variables,
    saved: savedVariables,
    source: unchanged ? "stored" : "draft",
    run: preview.run,
  });

  // One run of the steps for the preview and the steps editor, a moment behind typing.
  const deferredSteps = useDeferredValue(panel.transformations);
  const stepsRun = runPanelSteps(deferredSteps, results.data ?? []);

  const kindOf = (datasourceId: string) =>
    datasources.data?.find((d) => d.id === datasourceId)?.kind;
  // What the preview returned decides which panels fit; before it ran, what the sources can return.
  // An applied projection step turns that target's documents into a frame.
  const projected = (refId: string) => {
    const step = projectionFor(panel.transformations, refId);
    return step !== undefined && step.disabled !== true;
  };
  const returned = (results.data ?? []).flatMap((o): Shape[] =>
    "result" in o
      ? o.result.shape === "documents" && projected(o.refId)
        ? ["documents", "frame"]
        : [o.result.shape]
      : [],
  );
  const shapes: Shape[] = [
    ...new Set(
      returned.length > 0
        ? returned
        : panel.targets.flatMap((target): Shape[] => {
            const kindShapes =
              kinds.data?.find((k) => k.kind === kindOf(target.datasourceId))?.shapes ?? [];
            return projected(target.refId) ? [...kindShapes, "frame"] : kindShapes;
          }),
    ),
  ];

  const updateTarget = (refId: string, patch: Partial<Target>) =>
    setPanel((p) => ({
      ...p,
      targets: p.targets.map((target) =>
        target.refId === refId ? { ...target, ...patch } : target,
      ),
    }));

  function addTarget() {
    const first = queryable[0];
    setPanel((p) => ({
      ...p,
      targets: [
        ...p.targets,
        {
          refId: nextRefId(p.targets),
          datasourceId: p.targets.at(-1)?.datasourceId ?? first?.id ?? "",
          query: emptyQuery(kindOf(p.targets.at(-1)?.datasourceId ?? "") ?? first?.kind ?? ""),
        },
      ],
    }));
  }

  // A new run, or another data source, leaves an old filter refusal behind.
  const run = () => {
    setFilterError(null);
    setPreview((current) => ({ targets: panel.targets, run: current.run + 1 }));
  };

  /** Click-to-filter in the preview: a `$match` stage on that target's query, run at once. */
  function filterBy(refId: string, path: string, value: unknown) {
    // The filter joins the query in the editor, the draft typed since included; text that does
    // not parse, in the query or still in a field, is never replaced.
    const draft = panel.targets.find((target) => target.refId === refId);
    if (draft === undefined || !isMongoQuery(draft.query)) {
      return;
    }
    if (pendingText[refId] === true) {
      setFilterError(t("documents.filter.refused.draft"));
      return;
    }
    const added = addMatch(parseMongoQuery(draft.query), path, value);
    if ("refused" in added) {
      setFilterError(t(`documents.filter.refused.${added.refused}`));
      return;
    }
    setFilterError(null);
    const targets = panel.targets.map((target) =>
      target.refId === refId ? { ...target, query: added.query } : target,
    );
    setPanel((p) => ({ ...p, targets }));
    setPreview((current) => ({ targets, run: current.run + 1 }));
  }
  // A projection step the server would refuse is fixed here before the panel is applied.
  const blocked = hasProjectionProblems(panel.transformations);
  const plugin = getPanel(panel.type);
  const Editor = plugin?.Editor;

  return (
    <Dialog
      title={t("dashboards.editor.title")}
      onClose={onClose}
      size="large"
      actions={
        <>
          <button type="button" className="button button--secondary" onClick={onClose}>
            {t("dashboards.dialog.cancel")}
          </button>
          {blocked ? (
            <p className="field__error" id={`${titleId}-blocked`}>
              {t("documents.projection.blocked")}
            </p>
          ) : null}
          <button
            type="button"
            className="button button--primary"
            disabled={blocked}
            aria-describedby={blocked ? `${titleId}-blocked` : undefined}
            onClick={() =>
              onApply({ ...panel, transformations: storableTransformations(panel.transformations) })
            }
          >
            {t("dashboards.editor.apply")}
          </button>
        </>
      }
    >
      <div className="panel-editor">
        <section className="panel-editor__preview" aria-labelledby={titleId}>
          <h3 className="panel-editor__heading" id={titleId}>
            {t("dashboards.editor.preview")}
          </h3>
          {filterError === null ? null : (
            <p className="field__error" role="alert">
              {filterError}
            </p>
          )}
          <div className="panel-editor__viz">
            <PanelBody
              panel={{ ...panel, targets: preview.targets }}
              title={panel.title}
              range={range}
              pending={results.isPending && results.fetchStatus !== "idle"}
              error={results.error}
              outcomes={results.data ?? []}
              revision={results.dataUpdatedAt}
              onFilter={
                preview.targets.some((target) => isMongoQuery(target.query)) ? filterBy : undefined
              }
              stepsRun={stepsRun}
              variables={variables}
            />
          </div>
        </section>
        <div className="panel-editor__settings">
          <div className="field">
            <label className="field__label" htmlFor={`${titleId}-title`}>
              {t("dashboards.editor.panelTitle")}
            </label>
            <input
              id={`${titleId}-title`}
              className="input"
              value={panel.title}
              onChange={(event) => {
                const title = event.currentTarget.value;
                setPanel((p) => ({ ...p, title }));
              }}
              data-autofocus
            />
          </div>
          <PanelPicker
            value={panel.type}
            shapes={shapes}
            onChange={(type) => {
              setOptionsByType((kept) => ({ ...kept, [panel.type]: panel.options }));
              setPanel((p) => ({ ...p, type, options: optionsByType[type] ?? {} }));
            }}
          />
          {plugin === undefined || Editor === undefined ? null : (
            <fieldset className="panel-editor__options">
              <legend className="field__label">{t("dashboards.editor.options")}</legend>
              <Editor
                options={plugin.options(panel.options)}
                onChange={(options: unknown) => setPanel((p) => ({ ...p, options }))}
              />
            </fieldset>
          )}
          {plugin?.fieldOptions === undefined ? null : (
            <fieldset className="panel-editor__options">
              <legend className="field__label">{t("panels.fieldOptions")}</legend>
              <FieldConfigEditor
                value={panel.fieldConfig}
                groups={plugin.fieldOptions}
                onChange={(fieldConfig) => setPanel((p) => ({ ...p, fieldConfig }))}
              />
            </fieldset>
          )}
        </div>
        <section className="panel-editor__queries" aria-labelledby={`${titleId}-queries`}>
          <div className="panel-editor__queries-header">
            <h3 className="panel-editor__heading" id={`${titleId}-queries`}>
              {t("dashboards.editor.queries")}
            </h3>
            <button type="button" className="button button--primary" onClick={run}>
              {t("dashboards.editor.run")}
            </button>
          </div>
          {panel.targets.map((target) => (
            <TargetEditor
              key={target.refId}
              orgId={orgId}
              target={target}
              datasources={queryable}
              readOnly={!queryable.some((source) => source.id === target.datasourceId)}
              onChange={(patch) => {
                if (patch.datasourceId !== undefined) {
                  setFilterError(null);
                }
                updateTarget(target.refId, patch);
              }}
              onRemove={() =>
                setPanel((p) => ({
                  ...p,
                  targets: p.targets.filter((x) => x.refId !== target.refId),
                  transformations: withProjection(p.transformations, target.refId, undefined),
                }))
              }
              onRun={run}
              previewRun={() => ({ range, variables })}
              onPendingText={(pending) =>
                setPendingText((current) =>
                  current[target.refId] === pending
                    ? current
                    : { ...current, [target.refId]: pending },
                )
              }
              projection={projectionFor(panel.transformations, target.refId)}
              fields={documentsOf(results.data ?? [])
                .filter((d) => d.refId === target.refId)
                .flatMap((d) => projectionPaths(schemaOf(d.documents)))}
              onProjection={(projection) =>
                setPanel((p) => ({
                  ...p,
                  transformations: withProjection(p.transformations, target.refId, projection),
                }))
              }
            />
          ))}
          {mayQuery ? (
            <button
              type="button"
              className="button button--secondary"
              onClick={addTarget}
              disabled={datasources.data === undefined || queryable.length === 0}
            >
              {t("dashboards.editor.addQuery")}
            </button>
          ) : null}
          {mayQuery && datasources.data?.length === 0 ? (
            <p className="field__hint">{t("dashboards.editor.noDatasources")}</p>
          ) : null}
          {mayQuery ? null : <p className="field__hint">{t("dashboards.editor.noQueryRight")}</p>}
        </section>
        <StepsEditor
          steps={asSteps(panel.transformations)}
          onChange={(steps) =>
            setPanel((p) => ({ ...p, transformations: withUnknown(p.transformations, steps) }))
          }
          refIds={panel.targets.map((target) => target.refId)}
          inputs={namedInputs(results.data ?? [])}
          run={stepsRun}
        />
      </div>
    </Dialog>
  );
}

function TargetEditor({
  orgId,
  target,
  datasources,
  readOnly,
  onChange,
  onRemove,
  onRun,
  previewRun,
  onPendingText,
  projection,
  fields,
  onProjection,
}: {
  /** The dashboard's time range and variables, for stage previews. */
  previewRun: () => PreviewRun;
  onPendingText: (pending: boolean) => void;
  orgId: string;
  target: Target;
  /** The projection step of this query, stored with the panel. */
  projection: FrameProjection | undefined;
  /** Field paths of the last preview, to suggest for the projection. */
  fields: readonly string[];
  onProjection: (projection: FrameProjection | undefined) => void;
  /** The sources the caller may query, to pick from. */
  datasources: readonly { id: string; name: string; kind: string }[];
  /** The target's source is not one of them: the query shows as stored and stays as it is. */
  readOnly: boolean;
  onChange: (patch: Partial<Target>) => void;
  onRemove: () => void;
  onRun: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const datasource = datasources.find((d) => d.id === target.datasourceId);
  if (readOnly && target.datasourceId !== "") {
    return (
      <section
        className="target"
        aria-label={t("dashboards.inspect.query", { refId: target.refId })}
      >
        <div className="target__header">
          <span className="target__ref">{target.refId}</span>
          <button
            type="button"
            className="button button--ghost"
            onClick={onRemove}
            aria-label={t("dashboards.editor.removeQuery", { refId: target.refId })}
          >
            {t("dashboards.editor.remove")}
          </button>
        </div>
        <pre className="target__stored">{queryText(target.query)}</pre>
        <p className="field__hint">{t("dashboards.editor.readOnlyQuery")}</p>
      </section>
    );
  }
  return (
    <section className="target" aria-label={t("dashboards.inspect.query", { refId: target.refId })}>
      <div className="target__header">
        <span className="target__ref">{target.refId}</span>
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
          className="button button--ghost"
          onClick={onRemove}
          aria-label={t("dashboards.editor.removeQuery", { refId: target.refId })}
        >
          {t("dashboards.editor.remove")}
        </button>
      </div>
      {datasource === undefined ? null : (
        <QueryEditor
          orgId={orgId}
          datasource={datasource}
          query={target.query}
          onChange={(query) => onChange({ query })}
          onRun={onRun}
          previewRun={previewRun}
          onPendingText={onPendingText}
          label={t("dashboards.inspect.query", { refId: target.refId })}
        />
      )}
      {datasource !== undefined && isMongoQuery(target.query) ? (
        <ProjectionEditor
          projection={projection}
          fields={[...new Set(fields)]}
          onChange={onProjection}
        />
      ) : null}
    </section>
  );
}
