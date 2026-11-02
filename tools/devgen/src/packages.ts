import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Stops with a clear message when the package's dependencies are not installed. The entry points
 * check this before they load the code that imports them, so a missing `npm ci` does not end in
 * a module resolution stack trace (which an MCP client shows as a server that "failed to start").
 */
export function requirePackages(): void {
  const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
  const missing = ["@modelcontextprotocol/sdk", "zod"].filter(
    (name) => !existsSync(join(packageDir, "node_modules", ...name.split("/"), "package.json")),
  );
  if (missing.length > 0) {
    process.stderr.write(
      `devgen: ${missing.join(" and ")} not installed; run npm ci in ${packageDir}\n`,
    );
    process.exit(1);
  }
}
