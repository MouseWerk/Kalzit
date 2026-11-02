#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS, type ToolDef } from "./tools.ts";

/**
 * The devkit as an MCP server over stdio. stdout carries the protocol only; nothing else may
 * write to it. Instances started here stop when this process ends (unless started detached).
 */
const server = new McpServer({ name: "kalzit-devkit", version: "0.1.0" });

for (const def of TOOLS as readonly ToolDef[]) {
  server.registerTool(
    def.name,
    { description: def.description, inputSchema: def.shape },
    async (args: Record<string, unknown>) => {
      try {
        const result = await def.run(args as never, { log: () => {} });
        return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: (error as Error).message }],
        };
      }
    },
  );
}

const transport = new StdioServerTransport();
// The client closing stdin ends the server; the exit hook stops the instances it owns.
process.stdin.on("close", () => process.exit(0));
await server.connect(transport);
