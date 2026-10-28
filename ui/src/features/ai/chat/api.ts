import { queryOptions } from "@tanstack/react-query";
import {
  expectShape,
  isRecord,
  request,
  requestStream,
  type StreamEvent,
} from "../../../api/client";

/**
 * The chats of "Fragen" (docs/api/ai.md, "Chat"): the caller's own chats, and a question that the
 * model answers with read-only tools, streamed as server-sent events.
 */

export interface ChatSource {
  id: string;
  name: string;
  kind: string;
}

export interface ChatSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** When the retention job deletes the chat unless it is used again. */
  expiresAt: number;
  datasourceIds: string[];
  /** The chosen sources the caller may still read. */
  datasources: ChatSource[];
}

export interface ChatList {
  items: ChatSummary[];
  retentionDays: number;
}

/** The error envelope's body, as a tool record or a failed answer carries it. */
export interface ChatError {
  code: string;
  message: string;
  reason?: string;
  params?: Record<string, string>;
}

/** One query's result inside a tool record: only what went to the provider. */
export interface ResultRecord {
  refId: string;
  datasourceId?: string;
  query?: unknown;
  /** `{shape: "frame", fields}`, `{shape: "documents", documents}` or `{shape: "graph", ...}`. */
  data?: Record<string, unknown>;
  rows: number;
  truncated: boolean;
  excludedValues: number;
  error?: ChatError;
}

export interface ToolRecord {
  status: "ok" | "error";
  datasource?: ChatSource;
  dashboard?: {
    id: string;
    title: string;
    panelId: string;
    panelTitle: string;
    datasourceIds?: string[];
  };
  query?: unknown;
  timeRange?: { from: number; to: number };
  results?: ResultRecord[];
  durationMs?: number;
  items?: unknown;
  schema?: unknown;
  proposal?: { title: string; explanation?: string };
  error?: ChatError;
  /** The person lost access to the result, or its source was closed to AI since. */
  withheld?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Absent while it runs, and when the answer was stopped before it finished. */
  record?: ToolRecord;
}

export interface Round {
  text: string;
  calls: ToolCall[];
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatProvider {
  name: string;
  kind: string;
  model: string;
  host: string;
}

export type Outcome = "ok" | "stopped" | "failed" | "toolLimit";

export interface Turn {
  rounds: Round[];
  usage?: Usage;
  provider?: ChatProvider;
  outcome: Outcome;
  error?: ChatError;
}

export interface Question {
  text: string;
  datasourceIds?: string[];
}

export type ChatMessage =
  | { seq: number; role: "user"; createdAt: number; content: Question }
  | { seq: number; role: "assistant"; createdAt: number; content: Turn };

export interface ChatView extends ChatSummary {
  messages: ChatMessage[];
}

function chatsPath(orgId: string): string {
  return `/api/orgs/${encodeURIComponent(orgId)}/ai/chats`;
}

function isChatSummary(value: unknown): value is ChatSummary {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.updatedAt === "number" &&
    typeof value.expiresAt === "number" &&
    Array.isArray(value.datasourceIds) &&
    Array.isArray(value.datasources)
  );
}

function isChatList(value: unknown): value is ChatList {
  return (
    isRecord(value) &&
    Array.isArray(value.items) &&
    value.items.every(isChatSummary) &&
    typeof value.retentionDays === "number"
  );
}

function isChatView(value: unknown): value is ChatView {
  return isChatSummary(value) && Array.isArray((value as { messages?: unknown }).messages);
}

export async function fetchChats(
  orgId: string,
  search: string,
  signal?: AbortSignal,
): Promise<ChatList> {
  const query = search.trim() === "" ? "" : `?q=${encodeURIComponent(search.trim())}`;
  const answer = await request("GET", `${chatsPath(orgId)}${query}`, undefined, { signal });
  return expectShape(answer, isChatList, "AI chats");
}

export async function fetchChat(orgId: string, chatId: string, signal?: AbortSignal) {
  const path = `${chatsPath(orgId)}/${encodeURIComponent(chatId)}`;
  return expectShape(await request("GET", path, undefined, { signal }), isChatView, "AI chat");
}

export async function createChat(orgId: string, datasourceIds: string[]): Promise<ChatView> {
  const answer = await request("POST", chatsPath(orgId), { datasourceIds });
  return expectShape(answer, isChatView, "AI chat");
}

export async function deleteChat(orgId: string, chatId: string): Promise<void> {
  await request("DELETE", `${chatsPath(orgId)}/${encodeURIComponent(chatId)}`);
}

export async function deleteAllChats(orgId: string): Promise<void> {
  await request("DELETE", chatsPath(orgId));
}

export const CHATS_KEY = "aiChats";

export function chatsQuery(orgId: string, search = "") {
  return queryOptions({
    queryKey: [CHATS_KEY, orgId, "list", search.trim()],
    queryFn: ({ signal }) => fetchChats(orgId, search, signal),
  });
}

export function chatQuery(orgId: string, chatId: string) {
  return queryOptions({
    queryKey: [CHATS_KEY, orgId, "one", chatId],
    queryFn: ({ signal }) => fetchChat(orgId, chatId, signal),
  });
}

export interface AskHandlers {
  onMeta: (meta: { chatId?: string; provider?: ChatProvider }) => void;
  onText: (text: string) => void;
  onTool: (call: ToolCall) => void;
  onToolResult: (id: string, record: ToolRecord) => void;
  onDone: (done: {
    usage?: Usage;
    outcome?: Outcome;
    toolCalls?: number;
    error?: ChatError;
  }) => void;
  onError: (error: ChatError | undefined) => void;
}

/** Sends a question and hands the answer's events to `handlers`; a refusal throws ApiError. */
export async function streamAsk(
  orgId: string,
  chatId: string,
  body: { text: string; datasourceIds: string[]; language: string },
  handlers: AskHandlers,
  signal: AbortSignal,
): Promise<void> {
  const path = `${chatsPath(orgId)}/${encodeURIComponent(chatId)}/messages`;
  const language = body.language === "de" ? "de" : "en";
  await requestStream(
    path,
    { text: body.text, datasourceIds: body.datasourceIds, language },
    (event: StreamEvent) => {
      const data = isRecord(event.data) ? event.data : {};
      switch (event.event) {
        case "meta":
          handlers.onMeta(data as { chatId?: string; provider?: ChatProvider });
          break;
        case "text":
          if (typeof data.text === "string") {
            handlers.onText(data.text);
          }
          break;
        case "tool":
          if (typeof data.id === "string" && typeof data.name === "string") {
            handlers.onTool({
              id: data.id,
              name: data.name,
              arguments: isRecord(data.arguments) ? data.arguments : {},
            });
          }
          break;
        case "toolResult":
          if (typeof data.id === "string" && isRecord(data.record)) {
            handlers.onToolResult(data.id, data.record as unknown as ToolRecord);
          }
          break;
        case "done":
          handlers.onDone(data as Parameters<AskHandlers["onDone"]>[0]);
          break;
        case "error":
          handlers.onError(isRecord(data.error) ? (data.error as unknown as ChatError) : undefined);
          break;
      }
    },
    { signal },
  );
}
