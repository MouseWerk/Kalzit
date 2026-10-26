import { vi } from "vitest";
import type { LiveMessage } from "../api/generated/shapes";
import { type LiveClientOptions, type LiveSocket, setLiveClientOptions } from "../live/client";

/**
 * A WebSocket stand-in for the live client: records what the client sends and lets a test play
 * the server (open, messages, close). Nothing happens until the test says so.
 */
export class FakeSocket implements LiveSocket {
  readyState = 0;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly sent: Record<string, unknown>[] = [];
  /** The close code the client closed with, if it did. */
  closedWith: number | undefined;

  constructor(readonly path: string) {}

  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }

  close(code?: number): void {
    this.closedWith = code ?? 1000;
    this.readyState = 3;
  }

  /** The server accepted the connection. */
  open(): void {
    this.readyState = 1;
    this.onopen?.(new Event("open"));
  }

  receive(message: LiveMessage): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(message) }));
  }

  /** The server (or the network) closed the connection. */
  drop(code = 1006, reason = ""): void {
    this.readyState = 3;
    this.onclose?.({ code, reason } as CloseEvent);
  }

  /** The subscribe messages sent so far. */
  subscribes(): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === "subscribe");
  }
}

/** Live clients made from now on use fake sockets; `sockets` lists them in order of opening. */
export function installFakeLive(options: Omit<LiveClientOptions, "open"> = {}) {
  const sockets: FakeSocket[] = [];
  setLiveClientOptions({
    ...options,
    open: (path) => {
      const socket = new FakeSocket(path);
      sockets.push(socket);
      return socket;
    },
  });
  return {
    sockets,
    last: (): FakeSocket => {
      const socket = sockets.at(-1);
      if (socket === undefined) {
        throw new Error("no live socket was opened");
      }
      return socket;
    },
    reset: () => setLiveClientOptions({}),
  };
}

/**
 * An IntersectionObserver stand-in (stubbed as a global; `unstubGlobals` removes it after the
 * test): `show` reports an element in or out of view to every observer watching it.
 */
export function installFakeIntersection() {
  const observers = new Set<{ callback: IntersectionObserverCallback; watched: Set<Element> }>();
  class FakeIntersectionObserver {
    private readonly entry: { callback: IntersectionObserverCallback; watched: Set<Element> };
    constructor(callback: IntersectionObserverCallback) {
      this.entry = { callback, watched: new Set() };
      observers.add(this.entry);
    }
    observe(element: Element) {
      this.entry.watched.add(element);
    }
    unobserve(element: Element) {
      this.entry.watched.delete(element);
    }
    disconnect() {
      observers.delete(this.entry);
    }
    takeRecords() {
      return [];
    }
  }
  vi.stubGlobal("IntersectionObserver", FakeIntersectionObserver);
  return {
    show(element: Element, visible: boolean) {
      for (const { callback, watched } of [...observers]) {
        if (watched.has(element)) {
          const entry = { target: element, isIntersecting: visible } as IntersectionObserverEntry;
          callback([entry], this as unknown as IntersectionObserver);
        }
      }
    },
    /** Elements some observer watches now. */
    watched(): Element[] {
      return [...observers].flatMap(({ watched }) => [...watched]);
    },
  };
}
