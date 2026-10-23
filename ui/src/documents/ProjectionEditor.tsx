import { useId } from "react";
import { type Translate, useI18n } from "../i18n/i18n";
import {
  type ColumnProblem,
  columnProblems,
  type FrameProjection,
  MAX_COLUMN_NAME_CHARS,
  MAX_PATH_CHARS,
  MAX_PROJECTION_COLUMNS,
  PROJECTION_TYPES,
  type ProjectionColumn,
  type ProjectionType,
} from "./projection";
import "./documents.css";
import "../features/dashboards/ui/shared.css";

const TYPE_CHOICES: readonly ("" | ProjectionType)[] = ["", ...PROJECTION_TYPES];

function problemText(t: Translate, problem: ColumnProblem): string {
  switch (problem.problem) {
    case "control":
      return t("documents.projection.error.control");
    case "length":
      return t("documents.projection.error.length", { max: problem.max });
    default:
      return t("documents.projection.error.duplicate", { name: problem.name });
  }
}

/**
 * The projection step of one query: which field paths become which columns of a table. Without
 * it, panels for tables say they need one; with it, that query's documents arrive as the table.
 * Stored with the panel (documents/projection.ts), shown under the query it belongs to. What the
 * server would refuse in a column is said at its field, and saving waits until it is fixed.
 */
export function ProjectionEditor({
  projection,
  fields,
  onChange,
}: {
  projection: FrameProjection | undefined;
  /** Field paths to suggest, from the schema or the last result. */
  fields: readonly string[];
  onChange: (projection: FrameProjection | undefined) => void;
}) {
  const { t } = useI18n();
  const baseId = useId();
  const listId = `${baseId}-fields`;
  const columns = projection?.columns ?? [];
  const problems = columnProblems(columns);
  // Every change keeps the rest of the step (whether it is applied).
  const setColumns = (next: ProjectionColumn[]) => onChange({ ...projection, columns: next });
  const replace = (index: number, column: ProjectionColumn) =>
    setColumns(columns.map((c, i) => (i === index ? column : c)));
  const full = columns.length >= MAX_PROJECTION_COLUMNS;
  return (
    <fieldset className="pipeline__projection">
      <legend className="field__label">{t("documents.projection.title")}</legend>
      <p className="field__hint">
        {projection === undefined
          ? t("documents.projection.none")
          : t("documents.projection.active")}{" "}
        {t("documents.projection.arrays")}
      </p>
      {projection === undefined ? null : (
        <label className="checkbox" htmlFor={`${baseId}-on`}>
          <input
            id={`${baseId}-on`}
            type="checkbox"
            checked={projection.disabled !== true}
            onChange={(event) => {
              const next: FrameProjection = { columns };
              if (!event.currentTarget.checked) {
                next.disabled = true;
              }
              onChange(next);
            }}
          />
          {t("documents.projection.apply")}
        </label>
      )}
      <datalist id={listId}>
        {fields.map((field) => (
          <option key={field} value={field} />
        ))}
      </datalist>
      {projection === undefined ? (
        <div>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => onChange({ columns: [{ path: "" }] })}
          >
            {t("documents.projection.add")}
          </button>
        </div>
      ) : (
        <>
          <ol className="pipeline__columns">
            {columns.map((column, index) => {
              const number = index + 1;
              const problem = problems[index] ?? null;
              const errorId = `${baseId}-${index}-error`;
              const invalid = (field: "path" | "name") =>
                problem?.field === field
                  ? { "aria-invalid": true as const, "aria-describedby": errorId }
                  : {};
              return (
                // biome-ignore lint/suspicious/noArrayIndexKey: columns are positions; paths can repeat while typing
                <li key={index} className="pipeline__column">
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-path`}>
                      {t("documents.projection.path", { number })}
                    </label>
                    <input
                      id={`${baseId}-${index}-path`}
                      className="input input--mono"
                      list={listId}
                      value={column.path}
                      maxLength={MAX_PATH_CHARS}
                      autoComplete="off"
                      spellCheck={false}
                      {...invalid("path")}
                      onChange={(event) =>
                        replace(index, { ...column, path: event.currentTarget.value })
                      }
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-name`}>
                      {t("documents.projection.name", { number })}
                    </label>
                    <input
                      id={`${baseId}-${index}-name`}
                      className="input"
                      value={column.name ?? ""}
                      maxLength={MAX_COLUMN_NAME_CHARS}
                      placeholder={column.path}
                      {...invalid("name")}
                      onChange={(event) => {
                        const next: ProjectionColumn = { ...column };
                        const name = event.currentTarget.value;
                        if (name === "") {
                          delete next.name;
                        } else {
                          next.name = name;
                        }
                        replace(index, next);
                      }}
                    />
                  </div>
                  <div className="field">
                    <label className="field__label" htmlFor={`${baseId}-${index}-type`}>
                      {t("documents.projection.type", { number })}
                    </label>
                    <select
                      id={`${baseId}-${index}-type`}
                      className="select"
                      value={column.type ?? ""}
                      onChange={(event) => {
                        const type = event.currentTarget.value as "" | ProjectionType;
                        const next: ProjectionColumn = { ...column };
                        if (type === "") {
                          delete next.type;
                        } else {
                          next.type = type;
                        }
                        replace(index, next);
                      }}
                    >
                      {TYPE_CHOICES.map((type) => (
                        <option key={type} value={type}>
                          {t(`documents.projection.type.${type === "" ? "auto" : type}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    className="button button--ghost button--small"
                    aria-label={t("documents.projection.removeColumn", { number })}
                    onClick={() => setColumns(columns.filter((_, i) => i !== index))}
                  >
                    {t("documents.pipeline.removeShort")}
                  </button>
                  {problem === null ? null : (
                    <p className="field__error pipeline__column-error" id={errorId}>
                      {problemText(t, problem)}
                    </p>
                  )}
                </li>
              );
            })}
          </ol>
          {full ? (
            <p className="field__hint">
              {t("documents.projection.full", { max: MAX_PROJECTION_COLUMNS })}
            </p>
          ) : null}
          <div className="pipeline__add">
            <button
              type="button"
              className="button button--secondary"
              disabled={full}
              onClick={() => setColumns([...columns, { path: "" }])}
            >
              {t("documents.projection.addColumn")}
            </button>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onChange(undefined)}
            >
              {t("documents.projection.remove")}
            </button>
          </div>
        </>
      )}
    </fieldset>
  );
}
