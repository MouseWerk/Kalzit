import { ForceLayout, forceIterations } from "./layoutEngine";
import {
  ITERATIONS_PER_UPDATE,
  type LayoutMessage,
  type LayoutRequest,
  UPDATE_INTERVAL_MS,
  WORK_INTERVAL_MS,
} from "./layoutProtocol";
import { placeLayout } from "./layouts/place";

/**
 * The layout worker: runs the layouts off the main thread, so the page stays responsive however
 * large the graph is. The force layout posts positions every few iterations and the graph settles
 * visibly; between batches it yields to its own event loop, so a newer request is seen at once.
 * The other layouts answer once and say how far they are meanwhile; the panel stops one by ending
 * the worker.
 */

// The worker's global scope, typed by what it uses: the project compiles against the DOM
// library, which cannot be combined with the webworker one.
interface WorkerScope {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null;
}
const scope = self as unknown as WorkerScope;
let current = 0;

function post(message: LayoutMessage) {
  scope.postMessage(message, message.type === "positions" ? [message.positions.buffer] : []);
}

scope.onmessage = (event) => {
  const message = event.data;
  current = message.run;
  const run = message.run;
  if (message.mode !== "force") {
    let said = performance.now();
    const result = placeLayout(message, (done, total) => {
      const now = performance.now();
      if (now - said >= WORK_INTERVAL_MS) {
        said = now;
        post({ type: "work", run, done, total });
      }
    });
    post({
      type: "positions",
      run,
      positions: result.positions,
      done: true,
      reversed: result.reversed,
      guides: result.guides,
    });
    return;
  }
  const layout = new ForceLayout(message, message.start);
  const total = forceIterations(message.count);
  let posted = 0;
  const tick = () => {
    if (current !== run) {
      return;
    }
    layout.step(Math.min(ITERATIONS_PER_UPDATE, total - layout.done));
    const done = layout.done >= total;
    // Each update costs the page a redraw of every node; a few per second look smooth enough.
    const now = performance.now();
    if (done || now - posted >= UPDATE_INTERVAL_MS) {
      posted = now;
      post({ type: "positions", run, positions: layout.positions(), done });
    }
    if (!done) {
      setTimeout(tick, 0);
    }
  };
  tick();
};
