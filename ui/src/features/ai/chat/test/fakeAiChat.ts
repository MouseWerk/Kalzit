import type { FakeArea, FakeAreaStates, FakeRequest } from "../../../../test/fakeServer";
import type { ChatMessage, ChatView, Turn } from "../api";

/**
 * The chat routes of docs/api/ai.md ("Chat") for tests: the caller's chats, and a question that
 * answers with scripted events and stores a scripted answer. Close enough to the server's
 * contract for the pages; the server has its own tests with both provider APIs.
 */
export interface FakeChatState {
  chats: ChatView[];
  retentionDays: number;
  /** The questions asked, with their chat and body. */
  asks: { chatId: string; body: Record<string, unknown> }[];
  /**
   * What the next question answers: the events of the stream and the answer the server stores,
   * or a refusal before the stream starts. `hang` keeps the stream open until it is aborted.
   */
  answer:
    | { events: { event: string; data: unknown }[]; turn: Turn; hang?: boolean }
    | {
        refusal: { status: number; code: string; reason?: string; params?: Record<string, string> };
      };
}

export const CHAT_T0 = Date.UTC(2026, 9, 27, 8, 42);
const DAY = 24 * 3600 * 1000;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function eventStream(events: { event: string; data: unknown }[], hang: boolean): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const { event, data } of events) {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      }
      if (!hang) {
        controller.close();
      }
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

/** A stored chat with a question and an answer. */
export function fakeChat(fields: Partial<ChatView> & { id: string; title: string }): ChatView {
  return {
    createdAt: CHAT_T0,
    updatedAt: CHAT_T0,
    expiresAt: CHAT_T0 + 30 * DAY,
    datasourceIds: [],
    datasources: [],
    messages: [],
    ...fields,
  };
}

export function chatMessages(question: string, turn: Turn): ChatMessage[] {
  return [
    { seq: 1, role: "user", createdAt: CHAT_T0, content: { text: question } },
    { seq: 2, role: "assistant", createdAt: CHAT_T0 + 4000, content: turn },
  ];
}

function summary(chat: ChatView): Omit<ChatView, "messages"> {
  const { messages: _, ...rest } = chat;
  return rest;
}

export function aiChatFake(_areas: FakeAreaStates): FakeArea<FakeChatState> {
  const state: FakeChatState = {
    chats: [],
    retentionDays: 30,
    asks: [],
    answer: {
      events: [{ event: "done", data: { outcome: "ok" } }],
      turn: { rounds: [], outcome: "ok" },
    },
  };
  let next = 1;
  return {
    state,
    handle: ({ method, route, search, body }: FakeRequest) => {
      const [, , , , ...parts] = route.split("/");
      if (parts[0] !== "ai" || parts[1] !== "chats") {
        return undefined;
      }
      const id = parts[2];
      if (id === undefined) {
        if (method === "GET") {
          const q = (search.get("q") ?? "").toLowerCase();
          const items = state.chats
            .filter((chat) => chat.title.toLowerCase().includes(q))
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map(summary);
          return json(200, { items, retentionDays: state.retentionDays });
        }
        if (method === "POST") {
          const chat = fakeChat({
            id: `chat-${next++}`,
            title: "",
            datasourceIds: Array.isArray(body.datasourceIds)
              ? (body.datasourceIds as string[])
              : [],
          });
          state.chats.push(chat);
          return json(201, chat);
        }
        if (method === "DELETE") {
          state.chats = [];
          return new Response(null, { status: 204 });
        }
        return undefined;
      }
      const chat = state.chats.find((candidate) => candidate.id === id);
      if (chat === undefined) {
        return json(404, { error: { code: "not_found", message: "not found" } });
      }
      if (parts[3] === undefined && method === "GET") {
        return json(200, chat);
      }
      if (parts[3] === undefined && method === "DELETE") {
        state.chats = state.chats.filter((candidate) => candidate !== chat);
        return new Response(null, { status: 204 });
      }
      if (parts[3] === "messages" && method === "POST") {
        state.asks.push({ chatId: id, body });
        const answer = state.answer;
        if ("refusal" in answer) {
          const { status, code, ...extra } = answer.refusal;
          return json(status, { error: { code, message: `server message for ${code}`, ...extra } });
        }
        const text = typeof body.text === "string" ? body.text : "";
        const seq = chat.messages.length;
        chat.messages.push(
          { seq: seq + 1, role: "user", createdAt: CHAT_T0, content: { text } },
          { seq: seq + 2, role: "assistant", createdAt: CHAT_T0, content: answer.turn },
        );
        chat.title = chat.title === "" ? text : chat.title;
        return eventStream(answer.events, answer.hang === true);
      }
      return undefined;
    },
  };
}
