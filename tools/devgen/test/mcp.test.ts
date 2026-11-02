import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { TOOLS } from "../src/tools.ts";
import { REPO } from "./helpers.ts";

const PACKAGE = join(REPO, "tools", "devgen");

describe("MCP server", () => {
  it("lists every tool over stdio and answers a call", async () => {
    const client = new Client({ name: "devgen-test", version: "0.0.0" });
    await client.connect(
      new StdioClientTransport({
        command: process.execPath,
        args: [join(PACKAGE, "src", "mcp.ts")],
        cwd: REPO,
      }),
    );
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(TOOLS.map((t) => t.name).sort());
      const scaffold = tools.find((t) => t.name === "scaffold_route");
      expect(scaffold?.inputSchema.required).toEqual(
        expect.arrayContaining([
          "module",
          "method",
          "path",
          "access",
          "handler",
          "summary",
          "docs",
        ]),
      );
      const result = await client.callTool({ name: "rules", arguments: {} });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "";
      expect(text).toContain("- [ ] Commits are authored as");
      const refused = await client.callTool({
        name: "i18n_add",
        arguments: { key: "Bad Key", en: "x", de: "y" },
      });
      expect(refused.isError).toBe(true);
    } finally {
      await client.close();
    }
  });
});

describe("CLI", () => {
  it("lists the commands and prints a tool's text", () => {
    const cli = join(PACKAGE, "src", "cli.ts");
    const help = execFileSync(process.execPath, [cli, "--help"], { encoding: "utf8" });
    for (const tool of TOOLS) {
      expect(help).toContain(tool.name.replace(/_/g, "-"));
    }
    const rules = execFileSync(process.execPath, [cli, "rules"], { encoding: "utf8" });
    expect(rules).toContain("## git");
    const usage = execFileSync(process.execPath, [cli, "scaffold-route", "--help"], {
      encoding: "utf8",
    });
    expect(usage).toContain("--reason-en");
  });
});
