import { useEffect, useMemo, useRef, useState } from "react";
import type { DocumentSet } from "../../api/generated/shapes";
import { useI18n } from "../../i18n/i18n";
import { runQuery } from "../datasources/api";
import { useSourceKinds } from "../datasources/useSourceKinds";
import { runPanelQuery } from "./api";
import { appendPages, outcomesOf, type TargetOutcome } from "./results";
import { intervalFor, MAX_DATA_POINTS } from "./timeRange";
import { errorBodyMessage, errorMessage } from "./ui/errors";
import { type PanelQueryInput, panelRequest } from "./usePanelResults";

/** "Load more" for the document sets of a panel whose source has more (`nextCursor`). */
export interface MoreDocuments {
  /** The target whose next page is on its way, if any. */
  loading: string | null;
  /** Why the last page could not be loaded. */
  error: string | null;
  /** Loads the page after `cursor` of the target `refId` and appends it. */
  load: (refId: string, cursor: string) => void;
}

interface Pages {
  /** The answer the pages continue; a new one (a run, a refresh) drops them. */
  of: readonly TargetOutcome[] | undefined;
  pages: Readonly<Record<string, readonly DocumentSet[]>>;
  loading: string | null;
  error: string | null;
}

const NONE: Pages = { of: undefined, pages: {}, loading: null, error: null };

/**
 * The panel's outcomes with the pages loaded after them, and the way to load the next one. A
 * stored panel continues through the panel route, which runs only the stored query of the target
 * (all a viewer may); a draft through the free route. The server binds each cursor to the caller
 * and the query, so a page always continues the answer it came from.
 */
export function usePanelPages(
  input: PanelQueryInput,
  data: readonly TargetOutcome[] | undefined,
): { outcomes: readonly TargetOutcome[]; more: MoreDocuments; pageCount: number } {
  const { t } = useI18n();
  const kindOf = useSourceKinds(input.orgId);
  const [state, setState] = useState<Pages>({ ...NONE, of: data });
  const abort = useRef<AbortController | null>(null);
  // A new answer or leaving the panel stops a page on its way.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the cleanup is what runs when a new answer arrives
  useEffect(() => () => abort.current?.abort(), [data]);
  const current: Pages = state.of === data ? state : { ...NONE, of: data };
  // The same array while nothing changed, so the panel's steps do not run again.
  const loaded = current.pages;
  const { outcomes, pageCount } = useMemo(() => {
    let outcomes: readonly TargetOutcome[] = data ?? [];
    let pageCount = 0;
    for (const [refId, pages] of Object.entries(loaded)) {
      outcomes = appendPages(outcomes, refId, pages);
      pageCount += pages.length;
    }
    return { outcomes, pageCount };
  }, [data, loaded]);

  async function load(refId: string, cursor: string) {
    const of = data;
    const keep = (update: (pages: Pages["pages"]) => Omit<Pages, "of">) =>
      setState((now) => {
        const base = now.of === of ? now.pages : {};
        return { of, ...update(base) };
      });
    keep((pages) => ({ pages, loading: refId, error: null }));
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    const { variables, targets, graphSteps } = panelRequest(input, kindOf);
    const { range } = input;
    const common = {
      timeRange: range,
      variables,
      maxDataPoints: MAX_DATA_POINTS,
      intervalMs: intervalFor(range),
    };
    try {
      let response: Awaited<ReturnType<typeof runQuery>>;
      if (input.source === "stored") {
        response = await runPanelQuery(
          input.orgId,
          input.dashboardId,
          input.panel.id,
          { ...common, cursors: { [refId]: cursor } },
          controller.signal,
        );
      } else {
        const target = targets.find((candidate) => candidate.refId === refId);
        if (target === undefined) {
          keep((pages) => ({ pages, loading: null, error: t("documents.more.failed") }));
          return;
        }
        const steps = graphSteps.get(refId);
        response = await runQuery(
          input.orgId,
          {
            ...common,
            queries: [
              {
                refId,
                datasourceId: target.datasourceId,
                query: target.query,
                cursor,
                ...(steps === undefined ? {} : { steps }),
              },
            ],
          },
          controller.signal,
        );
      }
      const [outcome] = outcomesOf(response, [refId]);
      if (outcome !== undefined && "result" in outcome && outcome.result.shape === "documents") {
        const page = outcome.result.documents;
        keep((pages) => ({
          pages: { ...pages, [refId]: [...(pages[refId] ?? []), page] },
          loading: null,
          error: null,
        }));
      } else {
        const message =
          outcome !== undefined && "error" in outcome
            ? errorBodyMessage(t, outcome.error)
            : t("documents.more.failed");
        keep((pages) => ({ pages, loading: null, error: message }));
      }
    } catch (problem) {
      // Stopped on purpose (a new answer, or the panel was left): nothing to report.
      if (controller.signal.aborted) {
        return;
      }
      keep((pages) => ({ pages, loading: null, error: errorMessage(t, problem) }));
    }
  }

  return {
    outcomes,
    pageCount,
    more: {
      loading: current.loading,
      error: current.error,
      load: (refId, cursor) => void load(refId, cursor),
    },
  };
}
