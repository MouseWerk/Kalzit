import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** Ports never handed out: 3000 is the UI dev server's and often taken by other tools. */
export const FORBIDDEN_PORTS: ReadonlySet<number> = new Set([3000]);

/** Asks the system for a free port on 127.0.0.1. */
function systemPort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolvePort(port));
    });
  });
}

/**
 * A free port on 127.0.0.1 that is not forbidden and not in `exclude` (ports already handed out
 * in this process). `pick` is for tests.
 */
export async function freePort(
  exclude: ReadonlySet<number> = new Set(),
  pick: () => Promise<number> = systemPort,
): Promise<number> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const port = await pick();
    if (port > 0 && !FORBIDDEN_PORTS.has(port) && !exclude.has(port)) {
      return port;
    }
  }
  throw new Error("no free port found after 50 attempts");
}

/** An instance id: time-ordered, random, safe in file and container names. */
export function newInstanceId(): string {
  return `${Date.now().toString(36)}-${randomBytes(4).toString("hex")}`;
}

/**
 * Creates the run folder of an instance below `base`, private to the user. Fails when it exists,
 * so two instances never share one, even with the same id.
 */
export function createRunDir(base: string, id: string): string {
  if (!/^[a-z0-9-]+$/.test(id)) {
    throw new Error(`invalid instance id ${id}`);
  }
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `inst-${id}`);
  mkdirSync(dir, { mode: 0o700 });
  return dir;
}
