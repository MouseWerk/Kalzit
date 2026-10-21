import { ForceLayout, forceIterations, hierarchyLayout } from "./layoutEngine";
import {
  ITERATIONS_PER_UPDATE,
  type LayoutProgress,
  type LayoutRequest,
  type LayoutStop,
} from "./layoutProtocol";

/**
 * The layout worker: runs ForceAtlas2 or the hierarchy layout off the main thread and posts
 * positions every few iterations, so the graph settles visibly while the page stays responsive.
 * Between batches it yields to its own event loop, so a newer request or a stop is seen at once.
 */

// The worker's global scope, typed by what it uses: the project compiles against the DOM
// library, which cannot be combined with the webworker one.
interface WorkerScope {
  postMessage(message: unknown, transfer: Transferable[]): void;
  onmessage: ((event: MessageEvent<LayoutRequest | LayoutStop>) => void) | null;
}
const scope = self as unknown as WorkerScope;
let current = 0;

function post(message: LayoutProgress) {
  scope.postMessage(message, [message.positions.buffer]);
}

scope.onmessage = (event) => {
  const message = event.data;
  current = message.run;
  if (message.type === "stop") {
    return;
  }
  const run = message.run;
  if (message.mode === "hierarchy") {
    const result = hierarchyLayout(message);
    post({
      type: "positions",
      run,
      positions: result.positions,
      done: true,
      reversed: result.reversed,
    });
    return;
  }
  const layout = new ForceLayout(message, message.start);
  const total = forceIterations(message.count);
  const tick = () => {
    if (current !== run) {
      return;
    }
    layout.step(Math.min(ITERATIONS_PER_UPDATE, total - layout.done));
    const done = layout.done >= total;
    post({ type: "positions", run, positions: layout.positions(), done });
    if (!done) {
      setTimeout(tick, 0);
    }
  };
  tick();
};
