import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UI_DIR } from "../paths.ts";
import { run, runChecked } from "../proc.ts";

/** The image of the e2e services (.github/scripts/e2e-services.sh). */
export const NEO4J_IMAGE = "neo4j:2026.10.0-community";

export interface Neo4jContainer {
  containerId: string;
  host: string;
  port: number;
  user: string;
  password: string;
}

/**
 * Starts a throwaway Neo4j container with a unique name and a random host port, waits until it
 * answers and seeds it with ui/e2e/fixtures/graph-shop.cypher. On failure the container is
 * removed again (by its id) before the error is thrown.
 */
export async function startNeo4j(id: string, password: string): Promise<Neo4jContainer> {
  // The password reaches Docker through the environment (`-e NAME` copies it from there), so it
  // is in no command line, process list or error message.
  const env = { ...process.env, NEO4J_AUTH: `neo4j/${password}`, NEO4J_PASSWORD: password };
  const containerId = (
    await runChecked(
      "docker",
      [
        "run",
        "-d",
        "--name",
        `kalzit-devkit-neo4j-${id}`,
        "--label",
        `kalzit-devkit-instance=${id}`,
        "-p",
        "127.0.0.1::7687",
        "-e",
        "NEO4J_AUTH",
        "-e",
        "NEO4J_server_memory_heap_initial__size=256m",
        "-e",
        "NEO4J_server_memory_heap_max__size=512m",
        "-e",
        "NEO4J_server_memory_pagecache_size=128m",
        NEO4J_IMAGE,
      ],
      { env },
    )
  ).trim();
  try {
    const mapped = (await runChecked("docker", ["port", containerId, "7687/tcp"])).trim();
    const first = mapped.split("\n")[0] ?? "";
    const port = Number(first.slice(first.lastIndexOf(":") + 1));
    const shell = (input: string) =>
      // cypher-shell reads NEO4J_PASSWORD from its environment.
      run(
        "docker",
        ["exec", "-i", "-e", "NEO4J_PASSWORD", containerId, "cypher-shell", "-u", "neo4j"],
        {
          input,
          env,
          timeoutMs: 60_000,
        },
      );
    let ready = false;
    for (let i = 0; i < 90 && !ready; i++) {
      ready = (await shell("RETURN 1;")).code === 0;
      if (!ready) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!ready) throw new Error("Neo4j did not become ready within three minutes");
    const fixture = readFileSync(join(UI_DIR, "e2e", "fixtures", "graph-shop.cypher"), "utf8")
      .split("\n")
      .filter((line) => !line.startsWith("//"))
      .join("\n");
    let seeded = false;
    for (let attempt = 0; attempt < 5 && !seeded; attempt++) {
      seeded = (await shell(fixture)).code === 0;
      if (!seeded) await new Promise((r) => setTimeout(r, 3000));
    }
    if (!seeded) throw new Error("seeding Neo4j with graph-shop.cypher failed");
    return { containerId, host: "127.0.0.1", port, user: "neo4j", password };
  } catch (error) {
    await removeContainer(containerId);
    throw error;
  }
}

/** Removes a container this toolkit started, by its id (never by name or pattern). */
export async function removeContainer(containerId: string): Promise<void> {
  if (/^[0-9a-f]{12,64}$/.test(containerId)) {
    await run("docker", ["rm", "-f", "-v", containerId], { timeoutMs: 60_000 });
  }
}
