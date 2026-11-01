import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

/**
 * A stand-in for an OpenAI-compatible provider (chat completions, streamed), like the mock of
 * ui/e2e/ai.spec.ts: the connection test gets "OK", an explanation and a summary get fixed
 * texts, anything else (Fragen) a short fixed answer. Started by `instance_start` as a process of
 * its own: `node fakeai.js <port> <run folder>`; the run folder is only there so the instance can
 * recognise its own process before it stops it.
 */

export function answerFor(prompt: string): string {
  if (prompt.includes("Reply with the single word OK.")) return "OK";
  if (prompt.includes("Explain this query")) {
    return "The query lists every region of the sales table once, in alphabetical order.";
  }
  if (prompt.includes("Summarize this result")) {
    return "There are four regions: Nord, Ost, Süd and West.";
  }
  return "This is the devkit's fake AI provider. Sales were highest in the region West.";
}

function handle(request: IncomingMessage, response: ServerResponse): void {
  let raw = "";
  request.on("data", (chunk: Buffer) => {
    raw += chunk.toString("utf8");
  });
  request.on("end", () => {
    if (request.method === "GET") {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "devkit-fake-1", object: "model" }] }));
      return;
    }
    let body: { messages?: { role: string; content: unknown }[] } = {};
    try {
      body = JSON.parse(raw === "" ? "{}" : raw);
    } catch {
      // An unreadable body gets the default answer.
    }
    const user = (body.messages ?? [])
      .filter((message) => message.role === "user")
      .map((message) => (typeof message.content === "string" ? message.content : ""))
      .join("\n");
    const text = answerFor(user);
    const half = Math.ceil(text.length / 2);
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    for (const part of [text.slice(0, half), text.slice(half)]) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    }
    response.write(
      `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
    );
    response.write(
      `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 50, completion_tokens: 12 } })}\n\n`,
    );
    response.end("data: [DONE]\n\n");
  });
}

const isMain = /\/instance\/fakeai\.[jt]s$/.test(process.argv[1]?.replaceAll("\\", "/") ?? "");
if (isMain) {
  const port = Number(process.argv[2]);
  createServer(handle).listen(port, "127.0.0.1", () => {
    process.stdout.write(`fake AI provider on http://127.0.0.1:${port}/v1\n`);
  });
}
