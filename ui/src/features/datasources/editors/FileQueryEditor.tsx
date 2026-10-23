import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useId } from "react";
import { type MessageKey, useI18n } from "../../../i18n/i18n";
import { useOrgPermissions } from "../../../org/useOrg";
import { datasourceQuery, type SourceSchema, schemaQuery, sourceAccess } from "../api";
import type { QueryEditorProps } from "./QueryEditor";
import "./editors.css";
import "./sourceEditors.css";

/** The settings that decide how the file is read, in the order the form shows them. */
const READ_SETTINGS = ["format", "delimiter", "decimal", "header"] as const;
/** Defaults of docs/api/datasources.md, for settings the source leaves out. */
const DEFAULTS: Record<(typeof READ_SETTINGS)[number], string | boolean> = {
  format: "auto",
  delimiter: "auto",
  decimal: "auto",
  header: true,
};

/**
 * CSV, JSON and NDJSON files. The data source names the file and how it is read (format,
 * delimiter, decimal mark, header), so the query is always `{}` and Run reads the file. The
 * editor shows what will be read: the file, its read settings and the columns or fields the
 * schema found, and leads to the source's settings for changes. Whatever a target kept from
 * another kind is sent as `{}` (normalizeQuery), so opening the editor changes nothing.
 */
export function FileQueryEditor({ orgId, datasource, label }: QueryEditorProps) {
  const { t } = useI18n();
  const id = useId();
  const permissions = useOrgPermissions();
  const schema = useQuery(schemaQuery(orgId, datasource.id));
  const detail = useQuery({ ...datasourceQuery(orgId, datasource.id), retry: false });
  const settings = detail.data?.settings;
  const mayEdit = detail.data !== undefined && sourceAccess(detail.data.access, permissions).write;

  const value = (name: (typeof READ_SETTINGS)[number]) => {
    const raw = settings?.[name] ?? DEFAULTS[name];
    if (typeof raw === "boolean") {
      return t(raw ? "datasources.editor.file.value.yes" : "datasources.editor.file.value.no");
    }
    const key = `datasources.editor.file.value.${String(raw)}` as MessageKey;
    return t(key);
  };
  const path = typeof settings?.path === "string" ? settings.path : undefined;

  return (
    <section className="query-editor source-query" aria-labelledby={`${id}-title`}>
      <h3 className="visually-hidden" id={`${id}-title`}>
        {label ?? t("datasources.editor.label")}
      </h3>
      <p className="field__hint">{t("datasources.editor.file.hint")}</p>
      {settings === undefined ? null : (
        <dl className="source-query__summary">
          <div>
            <dt>{t("datasources.settings.path")}</dt>
            <dd className="source-query__mono">{path ?? ""}</dd>
          </div>
          {READ_SETTINGS.map((name) => (
            <div key={name}>
              <dt>{t(`datasources.settings.${name}`)}</dt>
              <dd>{value(name)}</dd>
            </div>
          ))}
        </dl>
      )}
      {mayEdit ? (
        <p className="field__hint">
          <Link to="/data-sources/$datasourceId" params={{ datasourceId: datasource.id }}>
            {t("datasources.editor.file.change")}
          </Link>
        </p>
      ) : null}
      <FileSchema schema={schema.data} failed={schema.isError} pending={schema.isPending} />
    </section>
  );
}

function FileSchema({
  schema,
  failed,
  pending,
}: {
  schema: SourceSchema | undefined;
  failed: boolean;
  pending: boolean;
}) {
  const { t } = useI18n();
  if (failed) {
    return <p className="field__hint">{t("datasources.editor.file.schemaFailed")}</p>;
  }
  if (pending || schema === undefined) {
    return null;
  }
  const rows =
    schema.kind === "tables"
      ? (schema.tables[0]?.columns ?? []).map((c) => ({ name: c.name, type: c.type }))
      : schema.kind === "fields"
        ? schema.fields.map((f) => ({
            name: f.path,
            type: f.types.map((type) => type.name).join(", "),
          }))
        : [];
  if (rows.length === 0) {
    return null;
  }
  const heading =
    schema.kind === "tables" ? "datasources.editor.file.columns" : "datasources.editor.file.fields";
  return (
    <details className="query-editor__help" open={rows.length <= 12}>
      <summary>{t(heading, { count: rows.length })}</summary>
      <dl className="source-query__summary source-query__summary--schema">
        {rows.map((row) => (
          <div key={row.name}>
            <dt className="source-query__mono">{row.name}</dt>
            <dd>{row.type}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
