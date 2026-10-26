import { openSocket } from "../api/client";
import type {
  ErrorBody,
  LiveMessage,
  LiveMode,
  LiveSubscribe,
  QueryOutcome,
} from "../api/generated/shapes";

/**
 * The live connection of one organization (docs/api/live.md): one WebSocket per browser tab that
 * carries every live subscription of the tab, opened with the first one and closed shortly after
 * the last one ends. It reconnects with growing, jittered waits after the server closed it for a
 * passing reason (a restart, a slow or idle client) or the network dropped, and subscribes
 * everything again; an ended session or membership stops it until someone starts live again.
 * While the tab is hidden it pauses (the socket is closed) and it resumes when the tab is shown.
 */

/** What a subscription asks for: the subscribe message without its `type` and `id`. */
export type LiveSpec = Omit<LiveSubscribe, "type" | "id">;

/** How a feed keeps its results current, from its latest `status`. */
export interface LiveStatus {
  mode: LiveMode;
  refreshMs: number;
  reason?: string | undefined;
}

export interface LiveListener {
  onResult: (results: Record<string, QueryOutcome>, at: number) => void;
  onStatus: (status: LiveStatus) => void;
  /** The subscription was refused or ended (by the server, or the connection stopped). */
  onError: (error: ErrorBody) => void;
}

/**
 * `idle`: no subscriptions; `connecting`; `open`; `retrying`: waiting before the next attempt;
 * `paused`: the tab is hidden; `stopped`: the session or membership ended.
 */
export type LiveConnection = "idle" | "connecting" | "open" | "retrying" | "paused" | "stopped";

export interface LiveConnectionState {
  state: LiveConnection;
  /** Why the connection was last closed by the server (`live.shutting_down`, ...). */
  reason?: string | undefined;
}

/** The parts of a WebSocket the client uses, so tests can hand in a fake. */
export interface LiveSocket {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface LiveClientOptions {
  open?: (path: string) => LiveSocket;
  /** 0 to 1, for the jitter. */
  random?: () => number;
  now?: () => number;
}

const OPEN = 1;
/** The first wait before reconnecting, doubled per failed attempt up to the longest. */
export const RETRY_BASE_MS = 1_000;
export const RETRY_MAX_MS = 30_000;
/** A connection that stayed open this long counts as working: the next wait starts small again. */
export const STABLE_MS = 15_000;
/** How long the socket stays open after its last subscription, for one that follows at once. */
export const LINGER_MS = 2_000;
/** How long a tab may stay hidden before live pauses, so a quick look elsewhere costs nothing. */
export const HIDDEN_GRACE_MS = 5_000;

/** Close codes and reasons after which the client does not reconnect by itself. */
const STOP_CODES = new Set([4001, 4003]);
const STOP_REASONS = new Set(["live.unauthenticated", "live.forbidden"]);

interface Subscription {
  spec: LiveSpec;
  listener: LiveListener;
  feed: string | undefined;
  /** The server ended it (an `error` with its id): not subscribed again on reconnect. */
  ended: boolean;
}

export class LiveClient {
  private readonly subs = new Map<string, Subscription>();
  private readonly watchers = new Set<() => void>();
  private socket: LiveSocket | null = null;
  private connection: LiveConnectionState = { state: "idle" };
  private nextId = 0;
  private attempts = 0;
  private openedAt = 0;
  /** The reason of a `closing` message, for the close that follows it. */
  private closingReason: string | undefined;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lingerTimer: ReturnType<typeof setTimeout> | undefined;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly open: (path: string) => LiveSocket;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly path: string,
    options: LiveClientOptions = {},
  ) {
    this.open = options.open ?? openSocket;
    this.random = options.random ?? Math.random;
    this.now = options.now ?? Date.now;
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.onVisibility);
    }
    if (typeof window !== "undefined") {
      window.addEventListener("online", this.onOnline);
    }
  }

  /** The connection's state, for an indicator; `watch` reports changes. */
  get state(): LiveConnectionState {
    return this.connection;
  }

  watch(onChange: () => void): () => void {
    this.watchers.add(onChange);
    return () => {
      this.watchers.delete(onChange);
    };
  }

  /** Starts a subscription; the function returned ends it. */
  subscribe(spec: LiveSpec, listener: LiveListener): () => void {
    this.nextId += 1;
    const id = `s${this.nextId}`;
    const sub: Subscription = { spec, listener, feed: undefined, ended: false };
    this.subs.set(id, sub);
    clearTimeout(this.lingerTimer);
    if (this.connection.state === "stopped") {
      sub.ended = true;
      listener.onError(stopError(this.connection.reason));
    } else if (this.socket !== null && this.socket.readyState === OPEN) {
      this.send({ type: "subscribe", id, ...spec });
    } else if (this.connection.state === "idle") {
      this.connect();
    }
    return () => this.unsubscribe(id);
  }

  /** Starts again after a stop (the person turned live on again), when anything is subscribed. */
  restart(): void {
    if (this.connection.state !== "stopped") {
      return;
    }
    for (const sub of this.subs.values()) {
      sub.ended = false;
    }
    this.attempts = 0;
    this.setState({ state: "idle" });
    if (this.active() > 0) {
      this.connect();
    }
  }

  /** Closes the socket and forgets every listener (tests, signing out). */
  dispose(): void {
    this.subs.clear();
    this.clearTimers();
    this.closeSocket();
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    if (typeof window !== "undefined") {
      window.removeEventListener("online", this.onOnline);
    }
    this.setState({ state: "idle" });
  }

  private unsubscribe(id: string) {
    const sub = this.subs.get(id);
    if (sub === undefined) {
      return;
    }
    this.subs.delete(id);
    if (!sub.ended && this.socket !== null && this.socket.readyState === OPEN) {
      this.send({ type: "unsubscribe", id });
    }
    if (this.active() === 0) {
      clearTimeout(this.lingerTimer);
      this.lingerTimer = setTimeout(() => this.goIdle(), LINGER_MS);
    }
  }

  /** Subscriptions still running (not ended by the server). */
  private active(): number {
    let count = 0;
    for (const sub of this.subs.values()) {
      if (!sub.ended) count += 1;
    }
    return count;
  }

  private goIdle() {
    if (this.active() > 0) {
      return;
    }
    clearTimeout(this.retryTimer);
    clearTimeout(this.hiddenTimer);
    this.closeSocket();
    if (this.connection.state !== "stopped") {
      this.setState({ state: "idle" });
    }
  }

  private connect() {
    clearTimeout(this.retryTimer);
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      this.setState({ state: "paused" });
      return;
    }
    this.closingReason = undefined;
    this.setState({ state: "connecting", reason: this.connection.reason });
    let socket: LiveSocket;
    try {
      socket = this.open(this.path);
    } catch {
      this.scheduleRetry(undefined);
      return;
    }
    this.socket = socket;
    socket.onopen = () => {
      if (this.socket !== socket) return;
      this.openedAt = this.now();
      this.setState({ state: "open" });
      for (const [id, sub] of this.subs) {
        if (!sub.ended) {
          sub.feed = undefined;
          this.send({ type: "subscribe", id, ...sub.spec });
        }
      }
    };
    socket.onmessage = (event) => {
      if (this.socket === socket && typeof event.data === "string") {
        this.onMessage(event.data);
      }
    };
    socket.onclose = (event) => {
      if (this.socket === socket) {
        this.onClose(event.code, this.closingReason ?? (event.reason || undefined));
      }
    };
    // A failed connection also closes; the close decides what happens next.
    socket.onerror = () => undefined;
  }

  private onMessage(text: string) {
    let message: LiveMessage;
    try {
      message = JSON.parse(text) as LiveMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case "subscribed": {
        const sub = this.subs.get(message.id);
        if (sub !== undefined) {
          sub.feed = message.feed;
        }
        break;
      }
      case "status":
        for (const sub of this.following(message.feed)) {
          sub.listener.onStatus({
            mode: message.mode,
            refreshMs: message.refreshMs,
            reason: message.reason,
          });
        }
        break;
      case "result":
        for (const sub of this.following(message.feed)) {
          sub.listener.onResult(message.results, message.at);
        }
        break;
      case "error": {
        // Without an id the server did not understand a message; nothing ended.
        const sub = message.id === undefined ? undefined : this.subs.get(message.id);
        if (sub !== undefined) {
          sub.ended = true;
          sub.feed = undefined;
          sub.listener.onError(message.error);
        }
        break;
      }
      case "closing":
        this.closingReason = message.error.reason;
        break;
    }
  }

  private following(feed: string): Subscription[] {
    return [...this.subs.values()].filter((sub) => !sub.ended && sub.feed === feed);
  }

  private onClose(code: number, reason: string | undefined) {
    this.socket = null;
    const wasStable = this.openedAt > 0 && this.now() - this.openedAt >= STABLE_MS;
    this.openedAt = 0;
    if (wasStable) {
      this.attempts = 0;
    }
    if (STOP_CODES.has(code) || (reason !== undefined && STOP_REASONS.has(reason))) {
      const stopReason = reason ?? (code === 4001 ? "live.unauthenticated" : "live.forbidden");
      this.setState({ state: "stopped", reason: stopReason });
      for (const sub of this.subs.values()) {
        if (!sub.ended) {
          sub.ended = true;
          sub.listener.onError(stopError(stopReason));
        }
      }
      return;
    }
    if (this.connection.state === "paused") {
      return;
    }
    if (this.active() === 0) {
      this.setState({ state: "idle" });
      return;
    }
    this.scheduleRetry(reason);
  }

  private scheduleRetry(reason: string | undefined) {
    // Half the grown wait plus a random part of the other half, so tabs that lost the server at
    // the same moment do not all come back at the same moment.
    const grown = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts);
    const wait = Math.round(grown / 2 + (this.random() * grown) / 2);
    this.attempts += 1;
    this.setState({ state: "retrying", reason });
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }

  private readonly onVisibility = () => {
    if (document.visibilityState === "hidden") {
      clearTimeout(this.hiddenTimer);
      this.hiddenTimer = setTimeout(() => this.pause(), HIDDEN_GRACE_MS);
      return;
    }
    clearTimeout(this.hiddenTimer);
    if (this.connection.state === "paused") {
      this.attempts = 0;
      if (this.active() > 0) {
        this.connect();
      } else {
        this.setState({ state: "idle" });
      }
    }
  };

  private readonly onOnline = () => {
    if (this.connection.state === "retrying") {
      this.connect();
    }
  };

  private pause() {
    const state = this.connection.state;
    if (state === "idle" || state === "stopped" || state === "paused") {
      return;
    }
    clearTimeout(this.retryTimer);
    this.setState({ state: "paused" });
    this.closeSocket();
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (socket !== null) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onclose = null;
      socket.onerror = null;
      socket.close(1000);
    }
  }

  private clearTimers() {
    clearTimeout(this.retryTimer);
    clearTimeout(this.lingerTimer);
    clearTimeout(this.hiddenTimer);
  }

  private send(message: object) {
    this.socket?.send(JSON.stringify(message));
  }

  private setState(next: LiveConnectionState) {
    if (next.state === this.connection.state && next.reason === this.connection.reason) {
      return;
    }
    this.connection = next;
    for (const watcher of this.watchers) {
      watcher();
    }
  }
}

function stopError(reason: string | undefined): ErrorBody {
  const unauthenticated = reason === "live.unauthenticated";
  return {
    code: unauthenticated ? "unauthenticated" : "forbidden",
    message: unauthenticated ? "the session ended" : "no access to this organization",
    reason: reason ?? "live.forbidden",
  };
}

const clients = new Map<string, LiveClient>();

/** The tab's live connection for an organization. */
export function liveClient(orgId: string): LiveClient {
  let client = clients.get(orgId);
  if (client === undefined) {
    client = new LiveClient(`/api/orgs/${encodeURIComponent(orgId)}/live`, clientOptions);
    clients.set(orgId, client);
  }
  return client;
}

let clientOptions: LiveClientOptions = {};

/** Tests: the socket factory (and clock, jitter) for clients made from now on; drops the others. */
export function setLiveClientOptions(options: LiveClientOptions): void {
  clientOptions = options;
  for (const client of clients.values()) {
    client.dispose();
  }
  clients.clear();
}
