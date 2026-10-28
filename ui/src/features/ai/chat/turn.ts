import type { MessageKey } from "../../../i18n/i18n";
import type { ChatError, ChatProvider, Outcome, ToolCall, ToolRecord, Turn, Usage } from "./api";

/**
 * An answer as the chat shows it: its text and its tool calls in the order they came. A stored
 * answer has rounds (each the model's text, then the calls it made); a streamed one arrives as
 * text and calls in turn. Both become the same steps.
 */
export type Step = { kind: "text"; text: string } | { kind: "call"; call: ToolCall };

export function stepsOf(turn: Turn): Step[] {
  const steps: Step[] = [];
  for (const round of turn.rounds) {
    if (round.text.trim() !== "") {
      steps.push({ kind: "text", text: round.text });
    }
    for (const call of round.calls) {
      steps.push({ kind: "call", call });
    }
  }
  return steps;
}

export function addText(steps: readonly Step[], text: string): Step[] {
  const last = steps.at(-1);
  if (last?.kind === "text") {
    return [...steps.slice(0, -1), { kind: "text", text: last.text + text }];
  }
  return [...steps, { kind: "text", text }];
}

export function addCall(steps: readonly Step[], call: ToolCall): Step[] {
  return [...steps, { kind: "call", call }];
}

export function setRecord(steps: readonly Step[], id: string, record: ToolRecord): Step[] {
  return steps.map((step) =>
    step.kind === "call" && step.call.id === id
      ? { kind: "call", call: { ...step.call, record } }
      : step,
  );
}

/** The queries an answer ran: free queries and panels, which the header counts. */
export function queriesRun(steps: readonly Step[]): number {
  return steps.filter(
    (step) =>
      step.kind === "call" &&
      (step.call.name === "run_query" || step.call.name === "run_panel") &&
      step.call.record !== undefined,
  ).length;
}

/** All words of an answer, for Copy and for the screen reader. */
export function answerText(steps: readonly Step[]): string {
  return steps
    .filter((step): step is { kind: "text"; text: string } => step.kind === "text")
    .map((step) => step.text.trim())
    .join("\n\n");
}

const TOOL_LABELS: Record<string, MessageKey> = {
  list_datasources: "ai.chat.tool.list_datasources",
  get_schema: "ai.chat.tool.get_schema",
  run_query: "ai.chat.tool.run_query",
  find_panels: "ai.chat.tool.find_panels",
  run_panel: "ai.chat.tool.run_panel",
  propose_query: "ai.chat.tool.propose_query",
};

/** The catalog key that names what a tool did, or undefined for a tool this UI does not know. */
export function toolLabelKey(name: string): MessageKey | undefined {
  return Object.hasOwn(TOOL_LABELS, name) ? TOOL_LABELS[name] : undefined;
}

/** An answer being written: its steps so far and how far it got. */
export interface LiveAnswer {
  question: string;
  steps: Step[];
  provider?: ChatProvider | undefined;
  usage?: Usage | undefined;
  outcome?: Outcome | undefined;
  /** A failed answer's error body. */
  error?: ChatError | undefined;
  phase: "waiting" | "streaming" | "done" | "stopped" | "error";
  /** When the question was sent. */
  at: number;
}

/** The query text a record ran or proposes, as Copy takes it: the text, else its JSON. */
export function queryText(query: unknown): string {
  if (query !== null && typeof query === "object") {
    for (const key of ["sql", "expr", "cypher", "gsql", "lucene"]) {
      const text = (query as Record<string, unknown>)[key];
      if (typeof text === "string") {
        return text;
      }
    }
    return JSON.stringify(query, null, 2);
  }
  return typeof query === "string" ? query : "";
}

/** Days until `expiresAt`, rounded up; 0 when it is today or past. */
export function daysLeft(expiresAt: number, now: number): number {
  return Math.max(0, Math.ceil((expiresAt - now) / (24 * 3600 * 1000)));
}
