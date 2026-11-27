import type { ElkNode } from "elkjs/lib/elk-api";
import workerUrl from "elkjs/lib/elk-worker.min.js?url";

/**
 * Runs ELK (elkjs). This module and elkjs load only when a hierarchy panel picks ELK
 * (elkLayout.ts imports it with `import()`), so neither is part of the start bundle nor of the
 * graph panels' own chunk.
 *
 * elkjs's own worker build runs as a classic same-origin script: the server's CSP allows workers
 * from 'self' and it needs no eval. It is the only copy of ELK in the bundle: there is no
 * main-thread build (elk.bundled.js would ship the same 1.6 MB a second time), so without
 * workers the panel keeps Kalzit's layout (elkLayout.ts). Its protocol is one answer per message
 * (`{ id, cmd, ... }` in, `{ id, data }` or `{ id, error }` out): register the layered
 * algorithm, then lay out.
 */

/** A layout that takes longer than this is given up; the panel falls back to its own layout. */
export const ELK_TIMEOUT_MS = 60_000;

const REGISTER = 0;
const LAYOUT = 1;

interface ElkAnswer {
  id: number;
  data?: ElkNode;
  error?: unknown;
}

function failure(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "object" && error !== null && "message" in error) {
    return new Error(String(error.message));
  }
  return new Error("ELK failed");
}

/** Lays out in a worker of its own, ended once it answers, fails, times out or is aborted. */
export function layoutInWorker(graph: ElkNode, signal: AbortSignal): Promise<ElkNode> {
  return new Promise((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(workerUrl, { name: "elk" });
    } catch (error) {
      reject(failure(error));
      return;
    }
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      worker.terminate();
    };
    const abort = () => {
      end();
      reject(new DOMException("The layout was cancelled.", "AbortError"));
    };
    const timer = setTimeout(() => {
      end();
      reject(new Error("ELK took too long"));
    }, ELK_TIMEOUT_MS);
    worker.onmessage = (event: MessageEvent<ElkAnswer>) => {
      const answer = event.data;
      if (answer.error !== undefined) {
        end();
        reject(failure(answer.error));
      } else if (answer.id === LAYOUT) {
        end();
        if (answer.data === undefined) reject(new Error("ELK answered without a graph"));
        else resolve(answer.data);
      }
    };
    worker.onerror = (event) => {
      event.preventDefault();
      end();
      reject(new Error(event.message || "The ELK worker could not start"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    // The worker knows no algorithm until one is registered (elkjs's API does the same).
    worker.postMessage({ id: REGISTER, cmd: "register", algorithms: ["layered"] });
    worker.postMessage({ id: LAYOUT, cmd: "layout", graph, layoutOptions: {}, options: {} });
  });
}
