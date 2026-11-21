import { useMemo } from "react";
import { useStyleSources } from "../../styleSources";
import type { StyleItem } from "./evaluate";
import { StyleEditor } from "./StyleEditor";
import type { GraphStyle } from "./schema";
import { vocabularyOf } from "./useGraphStyle";

/**
 * The section "Stil" of the panel editor, for graph panels and for tables made from a graph: the
 * rule editor, counted on the preview's graphs, with the other panels' rules to copy.
 */
export function StyleSection({
  style,
  onChange,
  basis,
}: {
  style: GraphStyle;
  onChange: (style: GraphStyle) => void;
  basis?: { color: string; size: string; shape: string } | undefined;
}) {
  const sources = useStyleSources();
  const graphs = sources?.graphs;
  const data = useMemo(() => {
    if (graphs === undefined || graphs.length === 0) return null;
    // Nodes and edges once each, as the panel merges its results by id.
    const nodes = new Map<string, { labels: string[]; properties: Record<string, unknown> }>();
    const edges = new Map<string, { type: string; properties: Record<string, unknown> }>();
    for (const graph of graphs) {
      for (const node of graph.nodes) {
        const known = nodes.get(node.id);
        nodes.set(
          node.id,
          known === undefined
            ? { labels: [...node.labels], properties: { ...node.properties } }
            : {
                labels: [...new Set([...known.labels, ...node.labels])],
                properties: { ...known.properties, ...node.properties },
              },
        );
      }
      for (const edge of graph.edges) {
        if (!edges.has(edge.id))
          edges.set(edge.id, { type: edge.type, properties: edge.properties });
      }
    }
    const model = { nodes: [...nodes.values()], edges: [...edges.values()] };
    const items: { nodes: StyleItem[]; edges: StyleItem[] } = {
      nodes: model.nodes.map((n) => ({ kinds: n.labels, properties: n.properties })),
      edges: model.edges.map((e) => ({ kinds: [e.type], properties: e.properties })),
    };
    return { items, vocabulary: vocabularyOf(model) };
  }, [graphs]);
  return (
    <StyleEditor
      style={style}
      onChange={onChange}
      items={data?.items ?? null}
      vocabulary={data?.vocabulary ?? null}
      basis={basis}
      copySources={sources?.panels}
    />
  );
}
