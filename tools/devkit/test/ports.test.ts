import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { afterAll, describe, expect, it } from "vitest";
import { createRunDir, FORBIDDEN_PORTS, freePort, newInstanceId } from "../src/ports.ts";

describe("freePort", () => {
  it("never hands out port 3000 or a port already taken", async () => {
    const offered = [3000, 41000, 3000, 41001];
    const pick = async () => offered.shift() ?? 0;
    expect(await freePort(new Set([41000]), pick)).toBe(41001);
  });

  it("gives distinct real ports when told what is taken", async () => {
    const taken = new Set<number>();
    for (let i = 0; i < 5; i++) {
      const port = await freePort(taken);
      expect(FORBIDDEN_PORTS.has(port)).toBe(false);
      expect(taken.has(port)).toBe(false);
      taken.add(port);
    }
  });

  it("gives up when nothing usable comes", async () => {
    await expect(freePort(new Set(), async () => 3000)).rejects.toThrow(/no free port/);
  });
});

describe("instance ids and run folders", () => {
  const base = mkdtempSync(`${tmpdir()}/devkit-ports-`);
  afterAll(() => rmSync(base, { recursive: true, force: true }));

  it("makes ids that do not repeat", () => {
    const ids = new Set(Array.from({ length: 500 }, () => newInstanceId()));
    expect(ids.size).toBe(500);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]+-[0-9a-f]{8}$/);
  });

  it("gives every instance its own run folder and refuses to reuse one", () => {
    const a = createRunDir(base, newInstanceId());
    const b = createRunDir(base, newInstanceId());
    expect(a).not.toBe(b);
    expect(existsSync(a) && existsSync(b)).toBe(true);
    const id = newInstanceId();
    createRunDir(base, id);
    expect(() => createRunDir(base, id)).toThrow();
    expect(() => createRunDir(base, "../escape")).toThrow(/invalid instance id/);
  });
});
