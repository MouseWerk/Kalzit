import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { realForge } from "./lib/forge.ts";
import { repoRoot } from "./lib/repo.ts";
import { TOOLS, zodShape } from "./tools.ts";

/**
 * The tools as an MCP server on stdio (registered in the repository's .mcp.json as `devgen`).
 * Every call gets a fresh view of git and GitHub, so open pull requests are current. Nothing is
 * written to stdout except the protocol.
 */

const root = repoRoot();
const server = new McpServer({ name: "kalzit-devgen", version: "0.1.0" });

for (const tool of TOOLS) {
  server.registerTool(
    tool.name,
    { description: tool.description, inputSchema: zodShape(tool.fields) },
    async (args: Record<string, unknown>) => {
      try {
        const output = tool.run(args, { root, forge: realForge(root) });
        return { content: [{ type: "text" as const, text: output.text }] };
      } catch (error) {
        return {
          isError: true,
          content: [
            { type: "text" as const, text: error instanceof Error ? error.message : String(error) },
          ],
        };
      }
    },
  );
}

await server.connect(new StdioServerTransport());
