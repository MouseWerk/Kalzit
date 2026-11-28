import "./patterns.css";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import type { ElementSchema, GraphSourceSchema, SchemaLink } from "../../api/generated/shapes";
import { type MessageKey, useI18n } from "../../i18n/i18n";
import { errorMessage } from "../dashboards/ui/errors";
import { countInSchema, fetchGraphSchema, graphSchemaQuery } from "./api";
import { KIND_TEXT } from "./ElementPanel";
import { labelSlot, valueKind } from "./pattern";

/** The most labels the schema graph draws; the list and the search know all (decision 14). */
export const MAX_DRAWN_LABELS = 40;

const SOURCE_TEXT: Record<GraphSourceSchema["source"], MessageKey> = {
  procedures: "graphPatterns.schema.source.procedures",
  schemaInfo: "graphPatterns.schema.source.schemaInfo",
  sample: "graphPatterns.schema.source.sample",
  catalog: "graphPatterns.schema.source.catalog",
};

const ENGINE: Record<string, string> = {
  neo4j: "Neo4j",
  memgraph: "Memgraph",
  tigergraph: "TigerGraph",
};

interface GraphSchemaViewProps {
  orgId: string;
  datasource: { id: string; kind: string };
  /** "Im Muster verwenden": the label goes into the pattern as a new node. */
  onUseLabel?: ((label: string) => void) | undefined;
}

/**
 * The schema of a graph source (board Graph083, frames 15 and 16): labels as nodes and edge
 * types as edges with their counts, or a list per label; a label opens its properties with their
 * data types and its edges. Where the schema comes from and how fresh its counts are is said
 * under it; a sample is called a sample.
 */
export function GraphSchemaView({ orgId, datasource, onUseLabel }: GraphSchemaViewProps) {
  const { t, language, timeZone } = useI18n();
  const id = useId();
  const client = useQueryClient();
  const schema = useQuery(graphSchemaQuery(orgId, datasource.id));
  const [view, setView] = useState<"graph" | "list">(() =>
    typeof window !== "undefined" && window.matchMedia?.("(width < 48rem)").matches === true
      ? "list"
      : "graph",
  );
  const [search, setSearch] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  const [counts, setCounts] = useState<Record<string, number | "busy" | "failed">>({});
  const [reloading, setReloading] = useState(false);

  async function reload() {
    setReloading(true);
    try {
      const fresh = await fetchGraphSchema(orgId, datasource.id, true);
      client.setQueryData(graphSchemaQuery(orgId, datasource.id).queryKey, fresh);
    } catch {
      await schema.refetch();
    } finally {
      setReloading(false);
    }
  }

  async function count(label: string) {
    setCounts((c) => ({ ...c, [label]: "busy" }));
    try {
      const n = await countInSchema(orgId, datasource.id, { label });
      setCounts((c) => ({ ...c, [label]: n }));
    } catch {
      setCounts((c) => ({ ...c, [label]: "failed" }));
    }
  }

  if (schema.isPending) {
    return (
      <div className="pattern-schema" role="status">
        <p>{t("graphPatterns.schema.loading")}</p>
        <p className="field__hint">{t("graphPatterns.schema.loadingHint")}</p>
      </div>
    );
  }
  if (schema.isError) {
    return (
      <div className="pattern-schema">
        <div className="pattern-note" role="alert">
          <p>{t("graphPatterns.schema.failed")}</p>
          <div className="pattern-note__actions">
            <button
              type="button"
              className="button button--secondary button--small"
              onClick={() => void schema.refetch()}
            >
              {t("graphPatterns.schema.retry")}
            </button>
          </div>
          <details>
            <summary>{t("graphPatterns.schema.details")}</summary>
            <p>{errorMessage(t, schema.error)}</p>
          </details>
        </div>
      </div>
    );
  }
  const data = schema.data;
  const labelCount = (l: ElementSchema) => {
    const counted = counts[l.name];
    return typeof counted === "number" ? counted : l.count;
  };
  const engine = ENGINE[datasource.kind] ?? datasource.kind;
  const footer = (
    <p className="pattern-schema__source">
      {t(SOURCE_TEXT[data.source], {
        engine,
        labels: data.labels.length,
        types: data.edgeTypes.length,
        time: new Intl.DateTimeFormat(language, {
          dateStyle: "short",
          timeStyle: "short",
          ...(timeZone === null ? {} : { timeZone }),
        }).format(data.readAt),
        size: (data.sampleSize ?? 0).toLocaleString(language),
      })}{" "}
      <button
        type="button"
        className="button button--ghost button--small"
        disabled={reloading}
        onClick={() => void reload()}
      >
        {t("graphPatterns.schema.reload")}
      </button>
    </p>
  );
  if (data.labels.length === 0) {
    return (
      <div className="pattern-schema">
        <p>{t("graphPatterns.schema.empty")}</p>
        {footer}
      </div>
    );
  }
  const needle = search.trim().toLowerCase();
  const matching = (name: string) => needle === "" || name.toLowerCase().includes(needle);
  const drawn = [
    ...data.labels.slice(0, MAX_DRAWN_LABELS),
    // A label the search finds joins the drawing.
    ...data.labels.slice(MAX_DRAWN_LABELS).filter((l) => needle !== "" && matching(l.name)),
  ];
  const selected = data.labels.find((l) => l.name === chosen);
  return (
    <div className="pattern-schema">
      <div className="pattern-schema__bar">
        {/* biome-ignore lint/a11y/useSemanticElements: two toggle buttons, not a field set */}
        <div className="pattern-segmented" role="group" aria-label={t("graphPatterns.schema.view")}>
          {(["graph", "list"] as const).map((v) => (
            <button
              key={v}
              type="button"
              className="pattern-segmented__item"
              aria-pressed={view === v}
              onClick={() => setView(v)}
            >
              {t(v === "graph" ? "graphPatterns.schema.graph" : "graphPatterns.schema.list")}
            </button>
          ))}
        </div>
        <input
          className="input pattern-schema__search"
          type="search"
          aria-label={t("graphPatterns.schema.search")}
          placeholder={t("graphPatterns.schema.search")}
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
      {data.source === "sample" ? (
        <div className="pattern-note" role="note">
          <p>{t("graphPatterns.schema.sample")}</p>
        </div>
      ) : null}
      {data.truncated ? (
        <div className="pattern-note" role="note">
          <p>{t("graphPatterns.schema.truncated")}</p>
        </div>
      ) : null}
      {view === "graph" && data.labels.length > MAX_DRAWN_LABELS ? (
        <div className="pattern-note" role="note">
          <p>
            {t("graphPatterns.schema.many", { shown: MAX_DRAWN_LABELS, count: data.labels.length })}
          </p>
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => setView("list")}
          >
            {t("graphPatterns.schema.toList")}
          </button>
        </div>
      ) : null}
      <div className="pattern-schema__body">
        {view === "graph" ? (
          <SchemaDrawing
            schema={data}
            labels={drawn}
            chosen={chosen}
            count={labelCount}
            onChoose={setChosen}
          />
        ) : (
          <SchemaList schema={data} matching={matching} count={labelCount} onChoose={setChosen} />
        )}
        {selected === undefined ? null : (
          <section className="pattern-schema__detail" aria-labelledby={`${id}-detail`}>
            <h3 id={`${id}-detail`} className="pattern-panel__title">
              {selected.name}
            </h3>
            <p className="field__hint">
              {labelCount(selected) === undefined
                ? t("graphPatterns.schema.labelNoCount")
                : t("graphPatterns.schema.labelCount", {
                    count: (labelCount(selected) ?? 0).toLocaleString(language),
                  })}
            </p>
            <PropertiesTable element={selected} />
            <LinksTable name={selected.name} links={data.links} />
            <div className="pattern-note__actions">
              {onUseLabel === undefined ? null : (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  onClick={() => onUseLabel(selected.name)}
                >
                  {t("graphPatterns.schema.use")}
                </button>
              )}
              {labelCount(selected) === undefined ? (
                <button
                  type="button"
                  className="button button--secondary button--small"
                  disabled={counts[selected.name] === "busy"}
                  onClick={() => void count(selected.name)}
                >
                  {t("graphPatterns.schema.count")}
                </button>
              ) : null}
              {counts[selected.name] === "failed" ? (
                <span className="field__error">{t("graphPatterns.schema.countFailed")}</span>
              ) : null}
            </div>
          </section>
        )}
      </div>
      {footer}
    </div>
  );
}

function SchemaDrawing({
  schema,
  labels,
  chosen,
  count,
  onChoose,
}: {
  schema: GraphSourceSchema;
  labels: ElementSchema[];
  chosen: string | null;
  count: (l: ElementSchema) => number | undefined;
  onChoose: (label: string) => void;
}) {
  const { t, language } = useI18n();
  const size = 420;
  const radius = labels.length <= 1 ? 0 : size / 2 - 60;
  const at = new Map(
    labels.map((l, i) => {
      const angle = (i / Math.max(1, labels.length)) * Math.PI * 2 - Math.PI / 2;
      return [
        l.name,
        { x: size / 2 + Math.cos(angle) * radius, y: size / 2 + Math.sin(angle) * radius },
      ];
    }),
  );
  const links = schema.links.filter((l) => at.has(l.from) && at.has(l.to));
  return (
    <svg
      className="pattern-schema__drawing"
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label={t("graphPatterns.schema.drawing", {
        labels: labels
          .map((l) =>
            l.count === undefined
              ? l.name
              : t("graphPatterns.schema.labelWithCount", { name: l.name, count: count(l) ?? 0 }),
          )
          .join("; "),
      })}
    >
      <defs>
        <marker
          id="schema-arrow"
          viewBox="0 0 10 10"
          refX="9"
          refY="5"
          markerWidth="6"
          markerHeight="6"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="pattern-drawing__arrow" />
        </marker>
      </defs>
      {links.map((link) => {
        const a = at.get(link.from);
        const b = at.get(link.to);
        if (a === undefined || b === undefined) return null;
        const label =
          link.count === undefined
            ? link.type
            : `${link.type} · ${link.count.toLocaleString(language)}`;
        if (link.from === link.to) {
          return (
            <g key={`${link.from}-${link.type}-${link.to}`} className="pattern-edge">
              <path
                className="pattern-edge__line"
                d={`M${a.x - 10},${a.y - 26} C${a.x - 50},${a.y - 80} ${a.x + 50},${a.y - 80} ${a.x + 10},${a.y - 26}`}
                markerEnd="url(#schema-arrow)"
              />
              <text className="pattern-edge__label" x={a.x} y={a.y - 70} textAnchor="middle">
                {label}
              </text>
            </g>
          );
        }
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const length = Math.hypot(dx, dy) || 1;
        const ux = dx / length;
        const uy = dy / length;
        // Links both ways between two labels bend apart.
        const twin = links.some((o) => o.from === link.to && o.to === link.from);
        const bend = twin ? 18 : 0;
        const sx = a.x + ux * 28;
        const sy = a.y + uy * 28;
        const ex = b.x - ux * 30;
        const ey = b.y - uy * 30;
        const mx = (sx + ex) / 2 - uy * bend;
        const my = (sy + ey) / 2 + ux * bend;
        return (
          <g key={`${link.from}-${link.type}-${link.to}`} className="pattern-edge">
            <path
              className="pattern-edge__line"
              d={`M${sx},${sy} Q${mx},${my} ${ex},${ey}`}
              markerEnd="url(#schema-arrow)"
            />
            <text className="pattern-edge__label" x={mx} y={my - 4} textAnchor="middle">
              {label}
            </text>
          </g>
        );
      })}
      {labels.map((l) => {
        const p = at.get(l.name);
        if (p === undefined) return null;
        const n = count(l);
        const selected = chosen === l.name;
        return (
          // biome-ignore lint/a11y/noStaticElementInteractions: a part of a picture, picked by pointer
          <g
            key={l.name}
            className={selected ? "pattern-node pattern-node--selected" : "pattern-node"}
            transform={`translate(${p.x} ${p.y})`}
            data-slot={labelSlot(schema, l.name)}
            onClick={() => onChoose(l.name)}
          >
            <circle className="pattern-node__shape" r={26} />
            <text className="pattern-node__id" textAnchor="middle" dy="0.35em">
              {n === undefined ? "" : n.toLocaleString(language)}
            </text>
            <text className="pattern-node__label" textAnchor="middle" y={42}>
              {l.name}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function SchemaList({
  schema,
  matching,
  count,
  onChoose,
}: {
  schema: GraphSourceSchema;
  matching: (name: string) => boolean;
  count: (l: ElementSchema) => number | undefined;
  onChoose: (label: string) => void;
}) {
  const { t, language } = useI18n();
  const id = useId();
  const labels = schema.labels.filter(
    (l) => matching(l.name) || l.properties.some((p) => matching(p.name)),
  );
  const types = schema.edgeTypes.filter(
    (e) => matching(e.name) || e.properties.some((p) => matching(p.name)),
  );
  return (
    <div className="pattern-schema__list">
      <h3 className="pattern-schema__caption" id={`${id}-labels`}>
        {t("graphPatterns.schema.labels")}
      </h3>
      <ul aria-labelledby={`${id}-labels`}>
        {labels.map((l) => {
          const n = count(l);
          return (
            <li key={l.name}>
              <button
                type="button"
                className="pattern-schema__entry"
                onClick={() => onChoose(l.name)}
              >
                <span>{l.name}</span>
                <span className="pattern-schema__count">
                  {n === undefined ? "" : n.toLocaleString(language)}
                </span>
              </button>
              <PropertyList element={l} />
            </li>
          );
        })}
      </ul>
      <h3 className="pattern-schema__caption" id={`${id}-types`}>
        {t("graphPatterns.schema.edgeTypes")}
      </h3>
      <ul aria-labelledby={`${id}-types`}>
        {types.map((e) => {
          const ends = schema.links.filter((l) => l.type === e.name);
          return (
            <li key={e.name}>
              <span className="pattern-schema__entry pattern-schema__entry--static">
                <span>
                  {ends.length === 0
                    ? e.name
                    : `${e.name} · ${ends.map((l) => `${l.from || "*"} → ${l.to || "*"}`).join(", ")}`}
                </span>
                <span className="pattern-schema__count">
                  {e.count === undefined ? "" : e.count.toLocaleString(language)}
                </span>
              </span>
              <PropertyList element={e} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function PropertyList({ element }: { element: ElementSchema }) {
  const { t } = useI18n();
  if (element.properties.length === 0) return null;
  return (
    <dl className="pattern-schema__properties">
      {element.properties.map((p) => (
        <div key={p.name}>
          <dt>{p.name}</dt>
          <dd>{t(KIND_TEXT[valueKind(p.types)])}</dd>
        </div>
      ))}
    </dl>
  );
}

function PropertiesTable({ element }: { element: ElementSchema }) {
  const { t } = useI18n();
  if (element.properties.length === 0) {
    return <p className="field__hint">{t("graphPatterns.schema.noProperties")}</p>;
  }
  return (
    <table className="pattern-table">
      <caption>{t("graphPatterns.schema.properties")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("graphPatterns.schema.property")}</th>
          <th scope="col">{t("graphPatterns.schema.dataType")}</th>
        </tr>
      </thead>
      <tbody>
        {element.properties.map((p) => (
          <tr key={p.name}>
            <td>{p.name}</td>
            <td>{t(KIND_TEXT[valueKind(p.types)])}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function LinksTable({ name, links }: { name: string; links: SchemaLink[] }) {
  const { t, language } = useI18n();
  const mine = [
    ...links.filter((l) => l.from === name).map((l) => ({ link: l, out: true, other: l.to })),
    ...links.filter((l) => l.to === name).map((l) => ({ link: l, out: false, other: l.from })),
  ];
  if (mine.length === 0) return null;
  return (
    <table className="pattern-table">
      <caption>{t("graphPatterns.schema.edges")}</caption>
      <thead>
        <tr>
          <th scope="col">{t("graphPatterns.schema.edgeType")}</th>
          <th scope="col">{t("graphPatterns.schema.direction")}</th>
          <th scope="col">{t("graphPatterns.schema.count")}</th>
        </tr>
      </thead>
      <tbody>
        {mine.map(({ link, out, other }, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a link may repeat with another count
          <tr key={`${link.type}-${out}-${other}-${i}`}>
            <td>{link.type}</td>
            <td>{`${out ? "→" : "←"} ${other || "*"}`}</td>
            <td>{link.count === undefined ? "" : link.count.toLocaleString(language)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
