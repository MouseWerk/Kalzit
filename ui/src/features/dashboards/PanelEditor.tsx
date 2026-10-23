import { useQuery } from "@tanstack/react-query";
import { useDeferredValue, useId, useState } from "react";
import { namedInputs, runPanelSteps } from "../../analysis/panel";
import { StepsEditor } from "../../analysis/StepsEditor";
import { asSteps, withUnknown } from "../../analysis/steps";
import type { Shape, TimeRange } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { useOrgPermissions } from "../../org/useOrg";
import { FieldConfigEditor } from "../../panels/fieldConfig/FieldConfigEditor";
import { upgradePanel } from "../../panels/fieldConfig/upgrade";
import { PanelPicker } from "../../panels/picker/PanelPicker";
import { getPanel } from "../../panels/registry";
import { datasourcesQuery, kindsQuery, sourceAccess } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { emptyQuery, queryText } from "../datasources/queryKinds";
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
import { Dialog } from "./ui/Dialog";
import { usePanelResults } from "./usePanelResults";

interface PanelEditorProps {
  orgId: string;
  dashboardId: string;
  panel: PanelModel;
  range: TimeRange;
  variables: VariableValues;
  /** The panel as saved, absent for a new one; unchanged targets preview through its route. */
  stored?: PanelModel | undefined;
  /** The saved dashboard's variables, for the panel route. */
  savedVariables?: readonly VariableModel[];
  onApply: (panel: PanelModel) => void;
  onClose: () => void;
  /** The dashboard's rows and variables, for the panel's place and repeat. */
  rows?: readonly RowModel[];
  dashboardVariables?: readonly VariableModel[];
  /** The library panel this one shows, by name. */
  libraryName?: string | undefined;
  /** Turns the edited panel into a library panel. */
  onMakeLibrary?: ((panel: PanelModel) => void) | undefined;
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
  rows = [],
  dashboardVariables = [],
  libraryName,
  onMakeLibrary,
}: PanelEditorProps) {
  const { t } = useI18n();
  const titleId = useId();
  const permissions = useOrgPermissions();
  // Panels saved before the field options existed move their old options to the new place.
  const [panel, setPanel] = useState(() => upgradePanel(initial));
  // Options per panel type seen in this editor, so arrowing through the picker and back to a
  // type keeps what was set for it.
  const [optionsByType, setOptionsByType] = useState<Record<string, unknown>>({});
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
  const returned = (results.data ?? []).flatMap((o) => ("result" in o ? [o.result.shape] : []));
  const shapes: Shape[] = [
    ...new Set(
      returned.length > 0
        ? returned
        : panel.targets.flatMap(
            (target) =>
              kinds.data?.find((k) => k.kind === kindOf(target.datasourceId))?.shapes ?? [],
          ),
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

  const run = () => setPreview((current) => ({ targets: panel.targets, run: current.run + 1 }));
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
          <button
            type="button"
            className="button button--primary"
            onClick={() => onApply(panel)}
            disabled={panelExtrasProblem(panel) !== null}
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
          <div className="panel-editor__viz">
            <PanelBody
              panel={{ ...panel, targets: preview.targets }}
              title={panel.title}
              range={range}
              pending={results.isPending && results.fetchStatus !== "idle"}
              error={results.error}
              outcomes={results.data ?? []}
              stepsRun={stepsRun}
              variables={variableTexts(variables)}
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
          <PanelExtras
            panel={panel}
            onChange={setPanel}
            rows={rows}
            variables={dashboardVariables}
            libraryName={panel.libraryPanelId === undefined ? undefined : libraryName}
            onMakeLibrary={onMakeLibrary === undefined ? undefined : () => onMakeLibrary(panel)}
          />
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
              onChange={(patch) => updateTarget(target.refId, patch)}
              onRemove={() =>
                setPanel((p) => ({
                  ...p,
                  targets: p.targets.filter((x) => x.refId !== target.refId),
                }))
              }
              onRun={run}
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
}: {
  orgId: string;
  target: Target;
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
          label={t("dashboards.inspect.query", { refId: target.refId })}
        />
      )}
    </section>
  );
}
