import { useQuery } from "@tanstack/react-query";
import { useId, useState } from "react";
import { TextField } from "../../components/TextField";
import { useI18n } from "../../i18n/i18n";
import { datasourcesQuery } from "../datasources/api";
import { QueryEditor } from "../datasources/editors/QueryEditor";
import { emptyQuery } from "../datasources/queryKinds";
import { isAllowedUrl } from "./links";
import type { AnnotationQueryModel, DashboardLinkModel } from "./model";
import "./dashboardTools.css";

/**
 * Parts of the dashboard settings that version 2 of the model added: tags, links in the header
 * and annotation queries (docs/api/dashboard-features.md).
 */

/** Tags as typed ("a, b"): trimmed, without empty or repeated entries. */
export function parseTags(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tag of text.split(",").map((t) => t.trim())) {
    if (tag !== "" && !seen.has(tag.toLowerCase())) {
      seen.add(tag.toLowerCase());
      out.push(tag);
    }
  }
  return out;
}

/** What is wrong with a link, as a message key, or null. */
export function linkProblem(
  link: DashboardLinkModel,
): "tagRequired" | "titleRequired" | "urlInvalid" | null {
  if (link.type === "dashboards") {
    return link.tag.trim() === "" ? "tagRequired" : null;
  }
  if (link.title.trim() === "") return "titleRequired";
  return isAllowedUrl(link.url) ? null : "urlInvalid";
}

export function LinksEditor({
  links,
  onChange,
  showErrors,
}: {
  links: DashboardLinkModel[];
  onChange: (links: DashboardLinkModel[]) => void;
  showErrors: boolean;
}) {
  const { t } = useI18n();
  const id = useId();
  const [keys, setKeys] = useState(() => links.map(() => crypto.randomUUID()));
  const update = (index: number, link: DashboardLinkModel) =>
    onChange(links.map((l, i) => (i === index ? link : l)));
  return (
    <fieldset className="settings__group">
      <legend className="section-title">{t("dashboardTools.links.title")}</legend>
      <p className="field__hint">{t("dashboardTools.links.hint")}</p>
      {links.map((link, index) => {
        const problem = showErrors ? linkProblem(link) : null;
        const label = link.title === "" ? t("dashboardTools.links.untitled") : link.title;
        return (
          <section key={keys[index]} className="settings__item" aria-label={label}>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-${index}-type`}>
                {t("dashboardTools.links.type")}
              </label>
              <select
                id={`${id}-${index}-type`}
                className="select"
                value={link.type}
                onChange={(event) =>
                  update(
                    index,
                    event.currentTarget.value === "url"
                      ? { type: "url", title: link.title, url: "" }
                      : { type: "dashboards", title: link.title, tag: "" },
                  )
                }
              >
                <option value="url">{t("dashboardTools.links.type.url")}</option>
                <option value="dashboards">{t("dashboardTools.links.type.dashboards")}</option>
              </select>
            </div>
            <TextField
              label={t("dashboardTools.links.linkTitle")}
              value={link.title}
              onValueChange={(title) => update(index, { ...link, title })}
              error={
                problem === "titleRequired" ? t("dashboardTools.links.titleRequired") : undefined
              }
              autoComplete="off"
            />
            {link.type === "url" ? (
              <TextField
                label={t("dashboardTools.links.url")}
                hint={t("dashboardTools.links.urlHint")}
                value={link.url}
                onValueChange={(url) => update(index, { ...link, url })}
                error={problem === "urlInvalid" ? t("dashboardTools.links.urlInvalid") : undefined}
                mono
                autoComplete="off"
              />
            ) : (
              <TextField
                label={t("dashboardTools.links.tag")}
                value={link.tag}
                onValueChange={(tag) => update(index, { ...link, tag })}
                error={
                  problem === "tagRequired" ? t("dashboardTools.links.tagRequired") : undefined
                }
                autoComplete="off"
              />
            )}
            <label className="checkbox">
              <input
                type="checkbox"
                checked={link.newTab === true}
                onChange={(event) =>
                  update(index, { ...link, newTab: event.currentTarget.checked })
                }
              />
              {t("dashboardTools.links.newTab")}
            </label>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => {
                onChange(links.filter((_, i) => i !== index));
                setKeys((list) => list.filter((_, i) => i !== index));
              }}
            >
              {t("dashboardTools.links.remove", { title: label })}
            </button>
          </section>
        );
      })}
      <button
        type="button"
        className="button button--secondary"
        onClick={() => {
          onChange([...links, { type: "url", title: "", url: "https://" }]);
          setKeys((list) => [...list, crypto.randomUUID()]);
        }}
      >
        {t("dashboardTools.links.add")}
      </button>
    </fieldset>
  );
}

export function AnnotationQueriesEditor({
  orgId,
  queries,
  onChange,
}: {
  orgId: string;
  queries: AnnotationQueryModel[];
  onChange: (queries: AnnotationQueryModel[]) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const datasources = useQuery(datasourcesQuery(orgId));
  const update = (index: number, patch: Partial<AnnotationQueryModel>) =>
    onChange(queries.map((q, i) => (i === index ? { ...q, ...patch } : q)));
  return (
    <fieldset className="settings__group">
      <legend className="section-title">{t("annotations.queries.title")}</legend>
      <p className="field__hint">{t("annotations.queries.hint")}</p>
      {queries.map((query, index) => {
        const source = datasources.data?.find((d) => d.id === query.datasourceId);
        return (
          <section key={query.id} className="settings__item" aria-label={query.name}>
            <TextField
              label={t("annotations.queries.name")}
              value={query.name}
              onValueChange={(name) => update(index, { name })}
              autoComplete="off"
            />
            <div className="field">
              <label className="field__label" htmlFor={`${id}-${index}-ds`}>
                {t("dashboards.editor.datasource")}
              </label>
              <select
                id={`${id}-${index}-ds`}
                className="select"
                value={query.datasourceId}
                onChange={(event) => {
                  const next = datasources.data?.find((d) => d.id === event.currentTarget.value);
                  update(index, {
                    datasourceId: event.currentTarget.value,
                    query: emptyQuery(next?.kind ?? ""),
                  });
                }}
              >
                <option value="">{t("dashboards.editor.pickDatasource")}</option>
                {(datasources.data ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            {source === undefined ? null : (
              <QueryEditor
                orgId={orgId}
                datasource={source}
                query={query.query}
                onChange={(next) => update(index, { query: next })}
              />
            )}
            <p className="field__hint">{t("annotations.queries.shapeHint")}</p>
            <div className="field">
              <label className="field__label" htmlFor={`${id}-${index}-color`}>
                {t("annotations.queries.color")}
              </label>
              <select
                id={`${id}-${index}-color`}
                className="select"
                value={query.color ?? 0}
                onChange={(event) => {
                  const color = Number(event.currentTarget.value);
                  const { color: _old, ...rest } = query;
                  onChange(
                    queries.map((q, i) =>
                      i === index ? (color === 0 ? rest : { ...rest, color }) : q,
                    ),
                  );
                }}
              >
                <option value={0}>{t("annotations.queries.colorNeutral")}</option>
                {[1, 2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {t("annotations.queries.colorN", { n })}
                  </option>
                ))}
              </select>
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={query.enabled}
                onChange={(event) => update(index, { enabled: event.currentTarget.checked })}
              />
              {t("annotations.queries.enabled")}
            </label>
            <button
              type="button"
              className="button button--ghost"
              onClick={() => onChange(queries.filter((_, i) => i !== index))}
            >
              {t("annotations.queries.remove", { name: query.name })}
            </button>
          </section>
        );
      })}
      <button
        type="button"
        className="button button--secondary"
        onClick={() =>
          onChange([
            ...queries,
            {
              id: crypto.randomUUID(),
              name: t("annotations.queries.defaultName"),
              datasourceId: "",
              query: null,
              enabled: true,
            },
          ])
        }
      >
        {t("annotations.queries.add")}
      </button>
    </fieldset>
  );
}
