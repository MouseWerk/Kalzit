import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { GALLERY_NOW } from "./datacenter";

/**
 * A stand-in for a local model server (an OpenAI-compatible endpoint, as Ollama offers it) for
 * the AI pictures of the gallery. It answers like a model would on the example data: the
 * connection test, an explanation and a summary of the Explore query, and the data chat ("Ask")
 * with its tool calls: the sources, the schema, one query, then the answer. Every figure in an
 * answer is computed from the gallery's SQLite file, so the words match the result next to them.
 */

const DAY = 24 * 3_600_000;

/** The query of the Explore pictures: PUE and IT load per hall. */
export const PUE_QUERY =
  'SELECT hall AS Hall, ROUND(AVG(facility_w * 1.0 / it_w), 2) AS PUE, ROUND(AVG(it_w) / 1000.0, 1) AS "IT kW" FROM hall_power WHERE $__timeFilter(ts) GROUP BY hall ORDER BY hall';

/** The question of the Ask picture and the query the "model" runs for it. */
export const ASK_QUESTION = "Which hall had the highest inlet temperatures today, and which racks?";
const ASK_QUERY =
  'SELECT hall AS Hall, rack AS Rack, ROUND(MAX(inlet_c), 1) AS "Max inlet °C", ROUND(AVG(inlet_c), 1) AS "Avg inlet °C" FROM rack_metrics WHERE $__timeFilter(ts) GROUP BY hall, rack ORDER BY 3 DESC LIMIT 5';

export interface Assistant {
  /** The base URL to enter for the provider. */
  baseUrl: string;
  close: () => Promise<void>;
}

/** SQLite's own text form for times, as datacenter.ts writes them. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

/** Runs a query of the pictures on the file, over the 24 hours before the gallery moment. */
function rows(file: string, sql: string): Record<string, number | string>[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const text = sql.replace(
      "$__timeFilter(ts)",
      `ts >= '${sqliteTime(GALLERY_NOW - DAY)}' AND ts <= '${sqliteTime(GALLERY_NOW)}'`,
    );
    return db.prepare(text).all() as Record<string, number | string>[];
  } finally {
    db.close();
  }
}

const one = (value: unknown) => Number(value).toFixed(1);

function explanation(): string {
  return [
    "The query reads the hall_power table for the chosen time range and groups its readings by hall.",
    "",
    "PUE is the facility power divided by the IT power of each reading, averaged per hall and rounded to two decimals. IT kW is the average IT power of the hall, in kilowatts with one decimal.",
    "",
    "One row per hall comes back, sorted by name. The time filter on ts limits the readings to the time range of the page.",
  ].join("\n");
}

function summary(file: string): string {
  const halls = rows(file, PUE_QUERY);
  const best = [...halls].sort((a, b) => Number(a.PUE) - Number(b.PUE))[0];
  const worst = [...halls].sort((a, b) => Number(b.PUE) - Number(a.PUE))[0];
  const load = [...halls].sort((a, b) => Number(b["IT kW"]) - Number(a["IT kW"]))[0];
  if (best === undefined || worst === undefined || load === undefined) return "No rows came back.";
  return [
    `Over the last 24 hours ${best.Hall} ran most efficiently with a PUE of ${Number(best.PUE).toFixed(2)}, ` +
      `while ${worst.Hall} needed the most overhead at ${Number(worst.PUE).toFixed(2)}.`,
    "",
    `${load.Hall} carries the largest IT load, ${one(load["IT kW"])} kW on average` +
      (Number(worst.PUE) < 1.4
        ? `; all ${halls.length} halls stay below a PUE of 1.4.`
        : `; ${worst.Hall} is above the warning level of 1.4.`),
  ].join("\n");
}

function answer(file: string): string {
  const found = rows(file, ASK_QUERY);
  const top = found[0];
  if (top === undefined) return "The query returned no readings for today.";
  const warmest = found.filter((row) => row.Hall === top.Hall);
  const racks = warmest.map((row) => `${row.Rack} (${one(row["Max inlet °C"])} °C)`);
  const peak = Number(top["Max inlet °C"]);
  const atRowEnds = warmest.every((row) => String(row.Rack).endsWith("-06"));
  return [
    `${top.Hall} had the highest inlet temperatures over the last 24 hours. ` +
      `The warmest racks were ${racks.join(", ")}.`,
    "",
    `The peak of ${one(peak)} °C at rack ${top.Rack} is ${peak >= 26 ? "above" : "below"} the ` +
      `warning threshold of 26 °C; its average was ${one(top["Avg inlet °C"])} °C.` +
      (atRowEnds ? " All of them sit at the row ends, next to the warm aisle return." : ""),
  ].join("\n");
}

type Chunk = Record<string, unknown>;

function stream(response: ServerResponse, chunks: Chunk[], promptTokens: number): void {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  for (const chunk of chunks) {
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
  }
  response.write(
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: promptTokens, completion_tokens: 96 } })}\n\n`,
  );
  response.end("data: [DONE]\n\n");
}

function textChunks(text: string): Chunk[] {
  // In a few pieces, as a model streams.
  const parts = text.match(/[\s\S]{1,120}/g) ?? [text];
  return [
    ...parts.map((part) => ({ choices: [{ delta: { content: part } }] })),
    { choices: [{ delta: {}, finish_reason: "stop" }] },
  ];
}

function toolCall(step: number, name: string, args: unknown): Chunk[] {
  return [
    {
      choices: [
        {
          delta: {
            tool_calls: [
              {
                index: 0,
                id: `call_${step}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
        },
      ],
    },
    { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
  ];
}

interface Body {
  messages?: { role: string; content: unknown }[];
  tools?: unknown[];
}

function reply(body: Body, file: string, datasourceId: string): Chunk[] {
  const messages = body.messages ?? [];
  const user = messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""))
    .join("\n");
  if ((body.tools ?? []).length > 0) {
    // The chat: one tool per turn until the query has run, then the answer.
    const done = messages.filter((message) => message.role === "tool").length;
    const range = { from: GALLERY_NOW - DAY, to: GALLERY_NOW };
    switch (done) {
      case 0:
        return toolCall(done, "list_datasources", {});
      case 1:
        return toolCall(done, "get_schema", { datasourceId });
      case 2:
        return toolCall(done, "run_query", {
          datasourceId,
          query: { sql: ASK_QUERY },
          timeRange: range,
        });
      default:
        return textChunks(answer(file));
    }
  }
  if (user.includes("Explain this query")) return textChunks(explanation());
  if (user.includes("Summarize this result")) return textChunks(summary(file));
  return textChunks("OK");
}

/**
 * Starts the stand-in on Ollama's port when it is free (so the pictures show the address a
 * local model server has), else on any port.
 */
export async function startAssistant(file: string, datasourceId: string): Promise<Assistant> {
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => {
      raw += chunk.toString("utf8");
    });
    request.on("end", () => {
      try {
        const body = JSON.parse(raw === "" ? "{}" : raw) as Body;
        stream(response, reply(body, file, datasourceId), Math.ceil(raw.length / 4));
      } catch (error) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  const listen = (port: number) =>
    new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => {
        server.off("error", reject);
        resolve();
      });
    });
  try {
    await listen(11434);
  } catch {
    await listen(0);
  }
  const { port } = server.address() as AddressInfo;
  return {
    // As an administrator enters a model server on the same machine.
    baseUrl: `http://localhost:${port}/v1`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
