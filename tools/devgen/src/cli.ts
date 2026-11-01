#!/usr/bin/env node
import { parseArgs } from "node:util";
import { proof } from "./proof.ts";
import { defaultContext, type Field, TOOLS } from "./tools.ts";

/**
 * The tools as CLI subcommands: `node tools/devgen/src/cli.ts <tool> [--flag value ...]`. Flags
 * are the tool's fields in kebab case (`--reason-en`); lists are comma separated or repeated.
 * `--json` prints the data instead of the text.
 */

function kebab(name: string): string {
  return name.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

function usage(): string {
  const lines = [
    "Usage: devgen <command> [flags]   (--json for machine output, --help per command)",
    "",
    "Commands:",
  ];
  for (const tool of TOOLS) {
    lines.push(`  ${tool.name.replace(/_/g, "-").padEnd(18)} ${tool.description}`);
  }
  lines.push(
    `  ${"proof".padEnd(18)} Scaffolds a route and a setting into a temporary checkout and runs fmt, clippy, the generated tests, Biome, the typecheck and the i18n tests`,
  );
  return lines.join("\n");
}

function commandHelp(name: string, fields: Field[]): string {
  return [
    `Usage: devgen ${name} ${fields
      .filter((f) => f.required === true)
      .map((f) => `--${kebab(f.name)} <${f.type}>`)
      .join(" ")}`,
    "",
    ...fields.map(
      (f) =>
        `  --${kebab(f.name).padEnd(16)} ${f.type}${f.choices === undefined ? "" : ` (${f.choices.join("|")})`}${f.required === true ? ", required" : ""}: ${f.description}`,
    ),
  ].join("\n");
}

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(`${usage()}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === "proof") {
    return proof(rest);
  }
  const tool = TOOLS.find((t) => t.name === command.replace(/-/g, "_"));
  if (tool === undefined) {
    process.stderr.write(`unknown command ${command}\n\n${usage()}\n`);
    return 1;
  }
  const options: Record<string, { type: "string" | "boolean"; multiple?: boolean }> = {
    json: { type: "boolean" },
    help: { type: "boolean" },
  };
  for (const field of tool.fields) {
    options[kebab(field.name)] =
      field.type === "boolean"
        ? { type: "boolean" }
        : field.type === "list"
          ? { type: "string", multiple: true }
          : { type: "string" };
  }
  const { values } = parseArgs({ args: rest, options, allowPositionals: false, strict: true });
  if (values.help === true) {
    process.stdout.write(`${commandHelp(command, tool.fields)}\n`);
    return 0;
  }
  const input: Record<string, unknown> = {};
  for (const field of tool.fields) {
    const value = values[kebab(field.name)];
    if (value === undefined) {
      continue;
    }
    if (field.type === "number") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`--${kebab(field.name)} needs a number`);
      }
      input[field.name] = n;
    } else if (field.type === "list") {
      input[field.name] = (value as string[])
        .flatMap((v) => v.split(","))
        .map((v) => v.trim())
        .filter((v) => v !== "");
    } else {
      input[field.name] = value;
    }
    if (field.choices !== undefined && !field.choices.includes(String(input[field.name]))) {
      throw new Error(`--${kebab(field.name)} is one of ${field.choices.join(", ")}`);
    }
  }
  for (const field of tool.fields) {
    if (field.required === true && input[field.name] === undefined) {
      throw new Error(`--${kebab(field.name)} is required\n\n${commandHelp(command, tool.fields)}`);
    }
  }
  const output = tool.run(input, defaultContext());
  process.stdout.write(
    values.json === true ? `${JSON.stringify(output.data, null, 2)}\n` : `${output.text}\n`,
  );
  // Lint and check commands fail when they found errors, so scripts and hooks can stop on them.
  const data = output.data as { errors?: unknown[]; clashes?: unknown[] } | { severity?: string }[];
  if (Array.isArray(data)) {
    return data.some((f) => f.severity === "error") ? 2 : 0;
  }
  if ((data.errors?.length ?? 0) > 0 || (data.clashes?.length ?? 0) > 0) {
    return 2;
  }
  return 0;
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(`devgen: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  },
);
