import { useId } from "react";
import type { FieldType } from "../api/generated/shapes";
import { useI18n } from "../i18n/i18n";
import { type FrameProjection, PROJECTION_TYPES, type ProjectionColumn } from "./projection";
import "./documents.css";
import "../features/dashboards/ui/shared.css";

const TYPE_CHOICES: readonly ("" | FieldType)[] = ["", ...PROJECTION_TYPES];

/**
 * The projection step of one query: which field paths become which columns of a table. Without
 * it, panels for tables say they need one; with it, that query's documents arrive as the table.
 * Stored with the panel (documents/projection.ts), shown under the query it belongs to.
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
  const replace = (index: number, column: ProjectionColumn) =>
    onChange({ columns: columns.map((c, i) => (i === index ? column : c)) });
  return (
    <fieldset className="pipeline__projection">
      <legend className="field__label">{t("documents.projection.title")}</legend>
      <p className="field__hint">
        {projection === undefined
          ? t("documents.projection.none")
          : t("documents.projection.active")}
      </p>
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
                      autoComplete="off"
                      spellCheck={false}
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
                      placeholder={column.path}
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
                        const type = event.currentTarget.value as "" | FieldType;
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
                    onClick={() => onChange({ columns: columns.filter((_, i) => i !== index) })}
                  >
                    {t("documents.pipeline.removeShort")}
                  </button>
                </li>
              );
            })}
          </ol>
          <div className="pipeline__add">
            <button
              type="button"
              className="button button--secondary"
              onClick={() => onChange({ columns: [...columns, { path: "" }] })}
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
