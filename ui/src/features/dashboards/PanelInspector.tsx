import { useQuery } from "@tanstack/react-query";
import { type ReactNode, useId, useRef, useState } from "react";
import { Icon } from "../../components/Icon";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { isComposingKey } from "../../lib/ime";
import { getPanel, panelName, useExternalPanels } from "../../panels/registry";
import { datasourcesQuery } from "../datasources/api";
import {
  clampGrid,
  GRID_COLUMNS,
  type GridPos,
  MAX_DESCRIPTION_CHARS,
  MAX_PANEL_HEIGHT,
  type PanelModel,
  type RowModel,
  type VariableModel,
} from "./model";
import { PanelExtras } from "./PanelExtras";
import { panelIcon, SWITCH_TYPES } from "./panelIcons";
import "./toolbar.css";

/** Widths offered as presets, in grid columns: a quarter, a third, a half, two thirds, all. */
const WIDTHS = [6, 8, 12, 16, 24] as const;

export interface InspectorActions {
  /** Changes the panel in the draft. */
  onChange: (change: (panel: PanelModel) => PanelModel) => void;
  /** A new place or size; the grid pushes overlapped panels down. */
  onGrid: (grid: GridPos) => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onCopy: () => void;
  onRemove: () => void;
  onMakeLibrary: () => void;
}

/**
 * The selected panel in edit mode, after the blueprint: what it is and where, then General,
 * Layout, Data, Display, Behavior and Library in sections, and the panel's actions. Every change
 * goes to the draft at once, as a drag on the canvas does.
 */
export function PanelInspector({
  orgId,
  panel,
  rows,
  variables,
  libraryName,
  actions,
}: {
  orgId: string;
  panel: PanelModel;
  rows: readonly RowModel[];
  variables: readonly VariableModel[];
  libraryName: string | undefined;
  actions: InspectorActions;
}) {
  const { t } = useI18n();
  const id = useId();
  const plugins = useExternalPanels();
  const plugin = getPanel(panel.type, plugins);
  const typeName = plugin === undefined ? panel.type : panelName(t, plugin);
  const row = rows.find((r) => r.id === panel.rowId);
  const rowName =
    row === undefined
      ? t("dashboardTools.inspector.noRow")
      : row.title === ""
        ? t("dashboardTools.rows.untitled")
        : row.title;
  const title = panel.title === "" ? t("dashboards.panel.untitled") : panel.title;
  const where = t("dashboardTools.inspector.typeInRow", { type: typeName, row: rowName });
  const linked = panel.libraryPanelId !== undefined;
  const set = <K extends keyof PanelModel>(key: K, value: PanelModel[K] | undefined) =>
    actions.onChange((p) => {
      const next = { ...p };
      if (value === undefined || value === "" || value === false) {
        delete next[key];
      } else {
        next[key] = value;
      }
      return next;
    });
  const grid = (patch: Partial<GridPos>) => actions.onGrid(clampGrid({ ...panel.grid, ...patch }));
  // Options per visualization, as in the panel editor: switching back brings them back, so a
  // look tried out is never lost while the panel stays selected.
  const optionsByType = useRef<Record<string, unknown>>({});
  function switchTo(type: string) {
    if (panel.type === type) return;
    actions.onChange((p) => {
      optionsByType.current = { ...optionsByType.current, [p.type]: p.options };
      return { ...p, type, options: optionsByType.current[type] ?? {} };
    });
  }

  return (
    <aside className="inspector" aria-labelledby={`${id}-title`}>
      <p className="inspector__caps">{t("dashboardTools.inspector.selected")}</p>
      <div className="inspector__head">
        <span className="inspector__type" aria-hidden="true">
          <Icon name={panelIcon(panel.type)} />
        </span>
        <div className="inspector__name">
          <h2 id={`${id}-title`} className="truncate" title={title}>
            {title}
          </h2>
          <p className="inspector__where truncate" title={where}>
            {where}
          </p>
        </div>
      </div>
      <button
        type="button"
        className="button button--secondary inspector__open"
        onClick={actions.onEdit}
      >
        {t("dashboardTools.inspector.openEditor")}
        <Icon name="external" />
      </button>

      <InspectorSection title={t("dashboardTools.inspector.general")} open>
        <TextField
          label={t("dashboards.editor.panelTitle")}
          value={panel.title}
          onValueChange={(text) => actions.onChange((p) => ({ ...p, title: text }))}
          autoComplete="off"
        />
        <div className="field">
          <label className="field__label" htmlFor={`${id}-description`}>
            {t("dashboardTools.inspector.description")}
          </label>
          <textarea
            id={`${id}-description`}
            className="input inspector__textarea"
            rows={3}
            maxLength={MAX_DESCRIPTION_CHARS}
            value={panel.description ?? ""}
            // White space alone is no description: the server refuses it, so it is left out.
            onChange={(event) => {
              const text = event.currentTarget.value;
              set("description", text.trim() === "" ? undefined : text);
            }}
          />
        </div>
        {linked ? null : (
          <PanelExtras
            panel={panel}
            parts={["links"]}
            bare
            onChange={actions.onChange}
            rows={rows}
            variables={variables}
          />
        )}
      </InspectorSection>

      <InspectorSection
        title={t("dashboardTools.inspector.layout")}
        summary={t("dashboardTools.inspector.layoutSummary", {
          w: panel.grid.w,
          h: panel.grid.h,
          x: panel.grid.x,
          y: panel.grid.y,
        })}
        open
      >
        <fieldset className="inspector__row">
          <legend className="inspector__label">{t("dashboardTools.inspector.width")}</legend>
          <div className="inspector__segmented">
            {WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                className="inspector__segment"
                aria-pressed={panel.grid.w === w}
                aria-label={t("dashboardTools.inspector.widthOf", { w, total: GRID_COLUMNS })}
                onClick={() => grid({ w, x: Math.min(panel.grid.x, GRID_COLUMNS - w) })}
              >
                {w}
              </button>
            ))}
          </div>
        </fieldset>
        <NumberRow
          label={t("dashboardTools.inspector.height")}
          hint={t("dashboardTools.inspector.heightHint")}
          value={panel.grid.h}
          min={1}
          max={MAX_PANEL_HEIGHT}
          stepper
          onChange={(h) => grid({ h })}
        />
        <div className="inspector__pair">
          <NumberRow
            label={t("dashboardTools.inspector.x")}
            value={panel.grid.x}
            min={0}
            max={GRID_COLUMNS - panel.grid.w}
            onChange={(x) => grid({ x })}
          />
          <NumberRow
            label={t("dashboardTools.inspector.y")}
            value={panel.grid.y}
            min={0}
            onChange={(y) => grid({ y })}
          />
        </div>
        {linked ? null : (
          <PanelExtras
            panel={panel}
            parts={["row"]}
            bare
            onChange={actions.onChange}
            rows={rows}
            variables={variables}
          />
        )}
      </InspectorSection>

      <InspectorSection title={t("dashboardTools.inspector.data")} open>
        <QuerySummary orgId={orgId} panel={panel} onEdit={actions.onEdit} />
        <PanelExtras
          panel={panel}
          parts={["time"]}
          bare
          onChange={actions.onChange}
          rows={rows}
          variables={variables}
        />
      </InspectorSection>

      <InspectorSection title={t("dashboardTools.inspector.display")} open>
        {linked ? (
          <p className="field__hint">{t("dashboardTools.inspector.linkedDisplay")}</p>
        ) : (
          <fieldset className="inspector__row inspector__row--stack">
            <legend className="inspector__label">
              {t("dashboardTools.inspector.visualization")}
              <span className="inspector__value">{typeName}</span>
            </legend>
            <div className="inspector__segmented inspector__segmented--icons">
              {SWITCH_TYPES.map((type) => {
                const name = getPanel(type)?.name;
                const label = name === undefined ? type : t(name);
                return (
                  <button
                    key={type}
                    type="button"
                    className="inspector__segment"
                    aria-pressed={panel.type === type}
                    aria-label={label}
                    title={label}
                    onClick={() => switchTo(type)}
                  >
                    <Icon name={panelIcon(type)} />
                  </button>
                );
              })}
            </div>
          </fieldset>
        )}
        <label className="inspector__switch">
          <span>{t("dashboardTools.inspector.transparent")}</span>
          <input
            type="checkbox"
            role="switch"
            aria-checked={panel.transparent === true}
            checked={panel.transparent === true}
            onChange={(event) => set("transparent", event.currentTarget.checked)}
          />
        </label>
      </InspectorSection>

      <InspectorSection title={t("dashboardTools.inspector.behavior")}>
        <PanelExtras
          panel={panel}
          parts={["repeat"]}
          bare
          onChange={actions.onChange}
          rows={rows}
          variables={variables}
        />
      </InspectorSection>

      <InspectorSection
        title={t("dashboardTools.inspector.library")}
        summary={linked ? libraryName : t("dashboardTools.inspector.notLinked")}
      >
        <p className="field__hint">{t("dashboardTools.inspector.libraryHint")}</p>
        <PanelExtras
          panel={panel}
          parts={["library"]}
          bare
          onChange={actions.onChange}
          rows={rows}
          variables={variables}
          libraryName={libraryName}
          onMakeLibrary={actions.onMakeLibrary}
        />
      </InspectorSection>

      <div className="inspector__actions">
        <button type="button" className="inspector__action" onClick={actions.onDuplicate}>
          <Icon name="copy" />
          {t("dashboards.panel.duplicate")}
        </button>
        <button type="button" className="inspector__action" onClick={actions.onCopy}>
          <Icon name="paste" />
          {t("dashboardTools.copy.panel")}
        </button>
        <button
          type="button"
          className="inspector__action inspector__action--danger"
          onClick={actions.onRemove}
        >
          <Icon name="trash" />
          {t("dashboards.panel.remove")}
        </button>
      </div>
    </aside>
  );
}

/** A section of the inspector: a disclosure with its title and, closed, a short summary. */
function InspectorSection({
  title,
  summary,
  open: initiallyOpen = false,
  children,
}: {
  title: string;
  summary?: string | undefined;
  open?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  return (
    <section className="inspector__section" aria-labelledby={`${id}-title`}>
      <h3 className="inspector__section-heading">
        <button
          type="button"
          className="inspector__toggle"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="inspector__chevron" aria-hidden="true">
            <Icon name="chevron" />
          </span>
          <span id={`${id}-title`}>{title}</span>
          {summary === undefined ? null : (
            <>
              {" "}
              <span className="inspector__summary truncate" title={summary}>
                {summary}
              </span>
            </>
          )}
        </button>
      </h3>
      <div id={`${id}-body`} className="inspector__body" hidden={!open}>
        {children}
      </div>
    </section>
  );
}

/**
 * A whole number with its label, optionally with − and + buttons. Typing changes nothing until
 * Enter or leaving the field, so a number typed digit by digit does not move panels around on
 * the way; an empty or wrong entry goes back to the value.
 */
function NumberRow({
  label,
  hint,
  value,
  min,
  max,
  stepper = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max?: number;
  stepper?: boolean;
  onChange: (value: number) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [text, setText] = useState(String(value));
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(String(value));
  }
  const within = (n: number) => Math.min(Math.max(n, min), max ?? Number.POSITIVE_INFINITY);
  function commit() {
    const next = Number(text);
    if (text.trim() === "" || !Number.isInteger(next)) {
      setText(String(value));
      return;
    }
    const clamped = within(next);
    setText(String(clamped));
    if (clamped !== value) onChange(clamped);
  }
  return (
    <div className="inspector__row">
      <label className="inspector__label" htmlFor={id}>
        {label}
      </label>
      <span className="inspector__number">
        {stepper ? (
          <button
            type="button"
            className="inspector__step"
            aria-label={t("dashboardTools.inspector.less", { label })}
            disabled={value <= min}
            onClick={() => onChange(within(value - 1))}
          >
            −
          </button>
        ) : null}
        <input
          id={id}
          className="input inspector__input"
          type="number"
          inputMode="numeric"
          min={min}
          max={max}
          step={1}
          value={text}
          aria-describedby={hint === undefined ? undefined : `${id}-hint`}
          onChange={(event) => setText(event.currentTarget.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !isComposingKey(event)) {
              event.preventDefault();
              commit();
            }
          }}
        />
        {stepper ? (
          <button
            type="button"
            className="inspector__step"
            aria-label={t("dashboardTools.inspector.more", { label })}
            disabled={max !== undefined && value >= max}
            onClick={() => onChange(within(value + 1))}
          >
            +
          </button>
        ) : null}
      </span>
      {hint === undefined ? null : (
        <span className="inspector__hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
/** How many queries the panel runs and on which sources, with a way into the editor. */
function QuerySummary({
  orgId,
  panel,
  onEdit,
}: {
  orgId: string;
  panel: PanelModel;
  onEdit: () => void;
}) {
  const { t } = useI18n();
  const sources = useQuery(datasourcesQuery(orgId));
  const names = [
    ...new Set(
      panel.targets.map(
        (target) =>
          sources.data?.find((s) => s.id === target.datasourceId)?.name ?? target.datasourceId,
      ),
    ),
  ].filter((name) => name !== "");
  const refs = panel.targets.map((target) => target.refId).join(", ");
  return (
    <button type="button" className="inspector__query" onClick={onEdit}>
      <span className="inspector__query-text">
        <span className="inspector__query-title">
          {panel.libraryPanelId !== undefined
            ? t("dashboardTools.inspector.libraryQueries")
            : panel.targets.length === 0
              ? t("dashboardTools.inspector.noQueries")
              : t(
                  panel.targets.length === 1
                    ? "dashboardTools.inspector.queryOne"
                    : "dashboardTools.inspector.queryMany",
                  { count: panel.targets.length, sources: names.join(", ") },
                )}
        </span>
        {refs === "" ? null : <span className="inspector__query-refs">{refs}</span>}
      </span>
      <Icon name="chevron" />
    </button>
  );
}
