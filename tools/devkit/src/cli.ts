#!/usr/bin/env node
import type { z } from "zod";

type AnySchema = z.core.$ZodType;

import { TOOLS, type ToolDef } from "./tools.ts";

/**
 * The devkit on the command line: `kalzit-devkit <tool> [arguments] [--option value ...]`, with
 * the MCP tools as subcommands (instance-start or instance_start). The result is JSON on stdout,
 * progress goes to stderr.
 */

type Kind = "string" | "number" | "boolean" | "array-string" | "array-number" | "other";

interface ZodLike {
  _zod: { def: { type: string; innerType?: ZodLike; element?: ZodLike } };
  description?: string;
}

/** What kind of value an option takes, through optional and default wrappers. */
export function kindOf(schema: AnySchema): Kind {
  let s = schema as unknown as ZodLike;
  while (["optional", "default", "nullable"].includes(s._zod.def.type) && s._zod.def.innerType) {
    s = s._zod.def.innerType;
  }
  const type = s._zod.def.type;
  if (type === "array") {
    const element = s._zod.def.element?._zod.def.type;
    return element === "number" ? "array-number" : "array-string";
  }
  if (type === "number" || type === "boolean" || type === "string") return type;
  if (type === "enum") return "string";
  return "other";
}

function convert(kind: Kind, raw: string): unknown {
  switch (kind) {
    case "number":
      return Number(raw);
    case "boolean":
      return raw !== "false" && raw !== "0" && raw !== "no";
    case "array-number":
      return raw.split(",").map((v) => Number(v.trim()));
    case "array-string":
      return raw
        .split(",")
        .map((v) => v.trim())
        .filter((v) => v !== "");
    default:
      return raw;
  }
}

const camel = (flag: string) => flag.replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase());

/** Turns command-line words into the tool's arguments; throws on unknown options. */
export function parseArgs(def: ToolDef, words: readonly string[]): Record<string, unknown> {
  const args: Record<string, unknown> = {};
  const positional = [...(def.positional ?? [])];
  for (let i = 0; i < words.length; i++) {
    const word = words[i] ?? "";
    if (!word.startsWith("--")) {
      const key = positional.shift();
      if (key === undefined) throw new Error(`unexpected argument ${word}`);
      const schema = def.shape[key];
      args[key] = schema === undefined ? word : convert(kindOf(schema), word);
      continue;
    }
    let name = word.slice(2);
    let value: string | undefined;
    const eq = name.indexOf("=");
    if (eq >= 0) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    let negated = false;
    let key = camel(name);
    if (def.shape[key] === undefined && name.startsWith("no-")) {
      key = camel(name.slice(3));
      negated = true;
    }
    const schema = def.shape[key];
    if (schema === undefined) throw new Error(`unknown option --${name} for ${def.name}`);
    const kind = kindOf(schema);
    if (kind === "boolean" && value === undefined) {
      const next = words[i + 1];
      if (next === "true" || next === "false") {
        value = next;
        i++;
      } else {
        args[key] = !negated;
        continue;
      }
    }
    if (value === undefined) {
      value = words[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
    }
    const converted = convert(kind, value);
    const before = args[key];
    args[key] =
      Array.isArray(before) && Array.isArray(converted) ? [...before, ...converted] : converted;
  }
  return args;
}

function help(): string {
  const lines = ["Usage: kalzit-devkit <tool> [arguments] [--option value ...]", "", "Tools:"];
  for (const def of TOOLS as readonly ToolDef[]) {
    const pos = (def.positional ?? []).map((p) => `<${p}>`).join(" ");
    lines.push(`  ${def.name.replace(/_/g, "-")} ${pos}`.trimEnd());
    for (const [key, schema] of Object.entries(def.shape)) {
      const flag = key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
      const description = (schema as unknown as ZodLike).description ?? "";
      lines.push(
        `      --${flag} (${kindOf(schema)})${description === "" ? "" : `  ${description}`}`,
      );
    }
  }
  lines.push(
    "",
    "Lists take comma-separated values or a repeated option. See tools/devkit/README.md.",
  );
  return lines.join("\n");
}

async function main(argv: readonly string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${help()}\n`);
    return 0;
  }
  const name = command.replace(/-/g, "_");
  const def = (TOOLS as readonly ToolDef[]).find((t) => t.name === name);
  if (def === undefined) {
    process.stderr.write(`unknown tool ${command}\n\n${help()}\n`);
    return 2;
  }
  const showCredentials = rest.includes("--show-credentials");
  const args = parseArgs(
    def,
    rest.filter((w) => w !== "--show-credentials"),
  );
  const log = (line: string) => process.stderr.write(`${line}\n`);
  const result = (await def.run(args as never, { log })) as Record<string, unknown>;
  if (def.name === "instance_start" && !showCredentials && typeof result === "object") {
    // Credentials stay in the run folder; stdout may end up in a log.
    result.credentials = "hidden; see credentialsFile, or pass --show-credentials";
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (def.name === "instance_start" && args.detached !== true) {
    log("Instance runs until this process ends (Ctrl+C), then it is stopped and removed.");
    await new Promise(() => {});
  }
  if (def.name === "merge_pr" && result.result !== "merged") return 1;
  if (def.name === "affected_tests" && Array.isArray(result.results)) {
    return (result.results as { code: number }[]).some((r) => r.code !== 0) ? 1 : 0;
  }
  return 0;
}

const isMain = /\/cli\.[jt]s$/.test(process.argv[1]?.replaceAll("\\", "/") ?? "");
if (isMain) {
  // Exit codes through process.exitCode: a hard process.exit while the browser's pipes are still
  // closing trips an assertion in libuv on Windows.
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: Error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
