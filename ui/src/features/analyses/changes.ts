import { asSteps } from "../../analysis/steps";
import type { MessageKey, Translate } from "../../i18n/i18n";
import { getPanel, panelName } from "../../panels/registry";
import type { AnalysisModel } from "./api";

/** One difference between two versions of an analysis, as a line of text. */
export interface AnalysisChange {
  key: MessageKey;
  params?: Record<string, string | number>;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** What changed from `before` to `after`, in the order the model reads. */
export function analysisChanges(
  t: Translate,
  before: AnalysisModel,
  after: AnalysisModel,
): AnalysisChange[] {
  const changes: AnalysisChange[] = [];
  if (before.title !== after.title) {
    changes.push({ key: "analyses.change.title", params: { title: after.title } });
  }
  if ((before.description ?? "") !== (after.description ?? "")) {
    changes.push({ key: "analyses.change.description" });
  }
  if (!same(before.timeRange, after.timeRange)) {
    changes.push({
      key: after.timeRange === null ? "analyses.change.rangeFollows" : "analyses.change.range",
      params:
        after.timeRange === null ? {} : { from: after.timeRange.from, to: after.timeRange.to },
    });
  }
  const old = new Map(before.targets.map((target) => [target.refId, target]));
  for (const target of after.targets) {
    const was = old.get(target.refId);
    if (was === undefined) {
      changes.push({ key: "analyses.change.queryAdded", params: { ref: target.refId } });
    } else if (!same(was, target)) {
      changes.push({ key: "analyses.change.query", params: { ref: target.refId } });
    }
    old.delete(target.refId);
  }
  for (const refId of old.keys()) {
    changes.push({ key: "analyses.change.queryRemoved", params: { ref: refId } });
  }
  if (!same(before.steps, after.steps)) {
    const from = asSteps(before.steps).length;
    const to = asSteps(after.steps).length;
    changes.push(
      from === to
        ? { key: "analyses.change.steps" }
        : { key: "analyses.change.stepCount", params: { from, to } },
    );
  }
  if (before.visualization.type !== after.visualization.type) {
    const name = (type: string) => {
      const plugin = getPanel(type);
      return plugin === undefined ? type : panelName(t, plugin);
    };
    changes.push({
      key: "analyses.change.visualization",
      params: { from: name(before.visualization.type), to: name(after.visualization.type) },
    });
  } else if (
    !same(before.visualization.options, after.visualization.options) ||
    !same(before.visualization.fieldConfig, after.visualization.fieldConfig)
  ) {
    changes.push({ key: "analyses.change.options" });
  }
  return changes;
}
