import { hasMessage, type MessageKey, type Translate } from "../i18n/i18n";
import { AlgoOutcome } from "./AlgoOutcome";
import { AlgoStepForm } from "./AlgoStepForm";
import {
  type GraphGroup,
  type GraphVariant,
  type GraphWords,
  LIBRARY_NAMES,
  libraryOf,
  plannedPlace,
} from "./algoSteps";
import type { CatalogEntry } from "./StepCatalog";

/**
 * The words and forms of the graph algorithm steps (board Graph082). Their texts are the deferred
 * area `graphSteps`: the steps editor loads this module behind it once a query answered a graph,
 * so a page without graphs never fetches them.
 */
export const GRAPH_WORDS: GraphWords = {
  kind: (t: Translate, key: string) => t(`graphSteps.kind.${key}` as MessageKey),
  entry: (t: Translate, variant: GraphVariant, base: CatalogEntry, kind: string | undefined) => {
    const library = plannedPlace(variant, kind);
    const help = `graphSteps.help.${variant.key}`;
    const words = `graphSteps.keywords.${variant.key}`;
    return {
      ...base,
      key: variant.key,
      label: t(`graphSteps.kind.${variant.key}` as MessageKey),
      about: t(`graphSteps.about.${variant.key}` as MessageKey),
      ...(hasMessage(help) ? { help: t(help) } : {}),
      keywords: hasMessage(words)
        ? t(words)
            .split(",")
            .map((w) => w.trim())
        : [],
      to: variant.table === true ? "frame" : "graph",
      graphGroup: variant.group,
      isNew: true,
      where:
        library === undefined
          ? t("graphSteps.where.serverAlgo")
          : t("graphSteps.where.libraryOrServer", LIBRARY_NAMES[library]),
      whereShort:
        library === undefined ? t("analysis.where.server") : LIBRARY_NAMES[library].engine,
    };
  },
  group: (t: Translate, group: GraphGroup | "other") =>
    t(`graphSteps.catalog.graphGroup.${group}` as MessageKey),
  badge: (t: Translate, ranIn: "database" | "server", kind: string | undefined) => {
    const library = libraryOf(kind);
    if (ranIn === "database" && library !== undefined) {
      return t("graphSteps.where.library", LIBRARY_NAMES[library]);
    }
    return ranIn === "database"
      ? t("analysis.where.database", { engine: kind ?? "" })
      : t("analysis.where.server");
  },
  added: (t: Translate, use: "size" | "color" | "groups", property: string) =>
    t(`graphSteps.algo.added.${use}` as MessageKey, { property }),
  running: (t: Translate) => t("graphSteps.algo.running"),
  mergeByLabel: (t: Translate) => t("graphSteps.algo.mergeBy.label"),
  AlgoStepForm,
  AlgoOutcome,
};
