import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { type Ref, useId, useState } from "react";
import type { Step } from "../../analysis/steps";
import { Icon } from "../../components/Icon";
import { HelpPanel } from "../../help/components/HelpPanel";
import { ShowQuery } from "../../help/components/Snippet";
import { type StartAction, StartPanel } from "../../help/components/StartPanel";
import type { Snippet } from "../../help/registry";
import { helpPanelShortcut } from "../../help/shortcut";
import type { Hint } from "../../help/sources/errors";
import {
  CHEAT_TOPICS,
  type GuideContext,
  guideDocs,
  guideFor,
  OBJECT_ACTIONS,
  type ObjectAction,
  pickable,
  type SourceGuide,
  type SqlDialect,
} from "../../help/sources/guides";
import { type SchemaObject, schemaObjects } from "../../help/sources/objects";
import { groupStepAsSql } from "../../help/sources/steps";
import { useI18n } from "../../i18n/i18n";
import { AiGate } from "../ai/AiGate";
import { datasourceQuery, schemaQuery } from "../datasources/api";
import { templateGraph } from "../datasources/editors/GsqlQueryEditor";
import { familyOf, queryText } from "../datasources/queryKinds";
import "../../help/help.css";
import "./explore.css";

/**
 * Explore's guidance for people new to a source's query language (docs/guide/query-languages.md),
 * built from the shared help layer (`help/`): the start panel, the schema list with its actions,
 * the cheat sheet, hints next to errors and the query behind a group step. Everything here only
 * fills the editor with read-only, bounded queries; running them takes the same path and checks
 * as a typed query.
 */

export interface ExploreGuideState {
  guide: SourceGuide | undefined;
  objects: SchemaObject[];
  context: GuideContext;
  pick: (name: string) => void;
  schemaFailed: boolean;
}

/** The guide of a source with its schema, and the object picked for the starters and snippets. */
export function useExploreGuide(
  orgId: string,
  datasource: { id: string; kind: string },
): ExploreGuideState {
  const guide = guideFor(datasource.kind);
  const schema = useQuery({ ...schemaQuery(orgId, datasource.id), enabled: guide?.pick != null });
  const tiger = datasource.kind === "tigergraph";
  // TigerGraph's graph name is a setting; members who may only query cannot read it.
  const settings = useQuery({
    ...datasourceQuery(orgId, datasource.id),
    enabled: tiger,
    retry: false,
  });
  const [picked, setPicked] = useState<Record<string, string>>({});
  // Sources without a language (files, HTTP JSON) have nothing to pick or act on.
  const objects = guide?.pick == null ? [] : schemaObjects(schema.data);
  const choices = guide === undefined ? [] : pickable(guide, objects);
  const object = choices.find((o) => o.name === picked[datasource.id]) ?? choices[0];
  return {
    guide,
    objects,
    context: {
      object,
      objects,
      graph: templateGraph(tiger ? settings.data?.settings.graph : undefined).graph,
    },
    pick: (name) => setPicked((current) => ({ ...current, [datasource.id]: name })),
    schemaFailed: schema.isError,
  };
}

/** The code of a query as the reader learns it. */
function codeOf(value: unknown): string {
  return queryText(value);
}

const objectLabel = (object: SchemaObject) =>
  object.schema === undefined || object.schema === ""
    ? object.name
    : `${object.schema}.${object.name}`;

/**
 * "Start here": what the source holds, a picker for its tables (collections, labels...), the
 * starters, and the other ways in. Each starter fills in its query and runs it.
 */
export function ExploreStart({
  state,
  source,
  kindName,
  onUse,
  onCheatSheet,
}: {
  state: ExploreGuideState;
  source: { id: string; kind: string };
  kindName: string;
  onUse: (value: unknown, options: { steps: boolean }) => void;
  onCheatSheet: () => void;
}) {
  const { t } = useI18n();
  const pickId = useId();
  const { guide, context } = state;
  if (guide === undefined) {
    return null;
  }
  const choices = pickable(guide, state.objects);
  const needsPick = guide.pick !== null;
  const actions: StartAction[] =
    needsPick && context.object === undefined
      ? []
      : guide.starters.flatMap((starter) => {
          const value = starter.build(context);
          return value === null
            ? []
            : [
                {
                  id: starter.id,
                  title: t(starter.title),
                  code: codeOf(value),
                  onUse: () => onUse(value, { steps: false }),
                },
              ];
        });
  const first = actions[0];
  const firstValue = guide.starters.map((s) => s.build(context)).find((v) => v !== null);
  const family = familyOf(source.kind);
  const shortcut = helpPanelShortcut();
  return (
    <StartPanel
      title={t("explore.guide.title", { kind: kindName })}
      lead={t(guide.holds)}
      picker={
        guide.pick === null || choices.length === 0 ? null : (
          <div className="field explore-guide__pick">
            <label className="field__label" htmlFor={pickId}>
              {t(guide.pick.label)}
            </label>
            <select
              id={pickId}
              className="select"
              value={context.object?.name ?? ""}
              onChange={(event) => state.pick(event.currentTarget.value)}
            >
              {choices.map((object) => (
                <option key={`${object.schema ?? ""}.${object.name}`} value={object.name}>
                  {objectLabel(object)}
                </option>
              ))}
            </select>
          </div>
        )
      }
      actions={actions}
      empty={
        needsPick && choices.length === 0
          ? state.schemaFailed
            ? t("explore.guide.schemaFailed")
            : t("explore.guide.nothingToPick")
          : undefined
      }
      footer={
        <>
          {guide.steps && first !== undefined && firstValue !== undefined ? (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={() => onUse(firstValue, { steps: true })}
            >
              <Icon name="rows" />
              {t("explore.guide.noCode")}
            </button>
          ) : null}
          {family === "plugin" || family === "file" || family === "http" ? null : (
            <button
              type="button"
              className="button button--ghost button--small"
              onClick={onCheatSheet}
              aria-keyshortcuts={shortcut.aria}
              title={t("help.panel.shortcut", { keys: shortcut.label })}
            >
              <Icon name="code" />
              {t("explore.guide.openCheatSheet")}
            </button>
          )}
          <AiGate feature="chat">
            <Link
              to="/ask"
              search={{ source: source.id }}
              className="button button--ghost button--small"
            >
              <Icon name="ask" />
              {t("explore.guide.ask")}
            </Link>
          </AiGate>
          <a href={guideDocs(guide)} target="_blank" rel="noopener noreferrer">
            {t("explore.guide.docs", { kind: kindName })}
            <Icon name="external" />
          </a>
        </>
      }
    />
  );
}

/** How many objects the schema list shows before asking for a search. */
const SHOWN_OBJECTS = 60;

/** The source's tables (collections, labels...) with their fields and the actions on each. */
export function SchemaList({
  state,
  onUse,
  searchRef,
}: {
  state: ExploreGuideState;
  onUse: (value: unknown) => void;
  searchRef?: Ref<HTMLInputElement>;
}) {
  const { t } = useI18n();
  const headingId = useId();
  const searchId = useId();
  const [search, setSearch] = useState("");
  const { guide, objects, context } = state;
  if (guide === undefined || objects.length === 0) {
    return null;
  }
  const words = search.trim().toLowerCase();
  const found = objects.filter((o) => objectLabel(o).toLowerCase().includes(words));
  const shown = found.slice(0, SHOWN_OBJECTS);
  return (
    <section className="explore-schema" aria-labelledby={headingId}>
      <h2 className="explore-schema__title" id={headingId}>
        {t("explore.schema.title")}
      </h2>
      <div className="field">
        <label className="field__label" htmlFor={searchId}>
          {t("explore.schema.search")}
        </label>
        <input
          id={searchId}
          ref={searchRef}
          className="input"
          type="search"
          value={search}
          onChange={(event) => setSearch(event.currentTarget.value)}
        />
      </div>
      <ul className="explore-schema__list">
        {shown.map((object) => {
          const label = objectLabel(object);
          const actions = OBJECT_ACTIONS.flatMap((action) => {
            const build = guide.actions[action];
            const value = build?.(object, context) ?? null;
            return value === null ? [] : [{ action, value }];
          });
          return (
            <li key={`${object.kind}:${label}`} className="explore-schema__item">
              <details className="explore-schema__details">
                <summary>
                  <span className="explore-schema__name">{label}</span>{" "}
                  <span className="explore-schema__kind">
                    {t(`explore.schema.kind.${object.kind}`)}
                  </span>
                </summary>
                {object.fields.length === 0 ? null : (
                  <ul className="explore-schema__fields">
                    {object.fields.slice(0, 200).map((field) => (
                      <li key={field.name}>
                        <code>{field.name}</code>
                        {field.type === "" ||
                        field.type === "label" ||
                        field.type === "value" ? null : (
                          <span className="explore-schema__type"> {field.type}</span>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </details>
              {actions.length === 0 ? null : (
                <div className="explore-schema__actions">
                  {actions.map(({ action, value }) => (
                    <button
                      key={action}
                      type="button"
                      className="button button--ghost button--small"
                      onClick={() => onUse(value)}
                      aria-label={t(`explore.schema.${action}Named`, { name: label })}
                      title={codeOf(value)}
                    >
                      {t(`explore.schema.${action}` as `explore.schema.${ObjectAction}`)}
                    </button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {found.length > shown.length ? (
        <p className="explore-schema__more">
          {t("explore.schema.more", { count: found.length - shown.length })}
        </p>
      ) : null}
      {found.length === 0 ? (
        <p className="explore-schema__more">{t("explore.schema.none")}</p>
      ) : null}
    </section>
  );
}

/** The cheat sheet of the source's language, with how Explore's time range and variables apply. */
export function ExploreCheatSheet({
  state,
  focus,
  onInsert,
  onClose,
}: {
  state: ExploreGuideState;
  focus: string | undefined;
  onInsert: (value: unknown, snippet: Snippet) => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { guide, context } = state;
  if (guide === undefined) {
    return null;
  }
  const shortcut = helpPanelShortcut();
  return (
    <HelpPanel
      title={t("explore.guide.cheatTitle", { language: guide.language })}
      lead={t("explore.guide.cheatLead")}
      topics={CHEAT_TOPICS}
      snippets={guide.cheats(context)}
      notes={
        <>
          <p>{t(guide.notes.time)}</p>
          <p>{t(guide.notes.variables)}</p>
        </>
      }
      docs={{ href: guideDocs(guide), label: t("explore.guide.docsShort") }}
      focus={focus}
      onInsert={onInsert}
      onClose={onClose}
      shortcut={shortcut.label}
    />
  );
}

/** The first snippet of a cheat sheet topic, which a hint links to. */
export function snippetOfTopic(state: ExploreGuideState, topic: string): string | undefined {
  return state.guide?.cheats(state.context).find((s) => s.topic === topic && s.value !== undefined)
    ?.id;
}

/** A plain-language hint next to an error, with where the fix is shown. */
export function ErrorHelp({
  hint,
  onCheatSheet,
  onSchema,
}: {
  hint: Hint;
  onCheatSheet: ((topic: string) => void) | undefined;
  onSchema: (() => void) | undefined;
}) {
  const { t } = useI18n();
  const { topic } = hint;
  return (
    <aside className="help-hint" aria-label={t("explore.hint.label")}>
      <p className="help-hint__text">{t(hint.text, hint.params)}</p>
      <div className="help-hint__actions">
        {topic === undefined || onCheatSheet === undefined ? null : (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={() => onCheatSheet(topic)}
          >
            {t("explore.hint.cheatSheet")}
          </button>
        )}
        {hint.schema === true && onSchema !== undefined ? (
          <button
            type="button"
            className="button button--secondary button--small"
            onClick={onSchema}
          >
            {t("explore.hint.schema")}
          </button>
        ) : null}
      </div>
    </aside>
  );
}

/**
 * The SQL behind a leading group step, for SQL sources: seen once, people can take the query
 * over and write the next one themselves.
 */
export function StepsQuery({
  kind,
  steps,
  query,
  onTakeOver,
}: {
  kind: string;
  steps: readonly Step[];
  query: unknown;
  onTakeOver: (value: { sql: string }, stepId: string) => void;
}) {
  const { t } = useI18n();
  if (familyOf(kind) !== "sql") {
    return null;
  }
  const folded = groupStepAsSql(steps, queryText(query), kind as SqlDialect);
  if (folded === null) {
    return null;
  }
  return (
    <div className="explore-steps-query">
      <ShowQuery code={folded.sql} label={t("explore.guide.stepsQuery")} />
      <button
        type="button"
        className="button button--secondary button--small"
        onClick={() => onTakeOver({ sql: folded.sql }, folded.stepId)}
      >
        {t("explore.guide.takeOver")}
      </button>
    </div>
  );
}
