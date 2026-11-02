import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { listInstances, startInstance, stopInstance } from "../src/instance/manager.ts";

/**
 * Local only (`npm run test:smoke`): builds or reuses the server binary (KALZIT_DEVKIT_BINARY
 * skips the build), starts a seeded instance with the fake AI provider, signs in and stops it.
 */
describe("instance", () => {
  it("starts on a free port with its own run folder, answers, and is gone after stop", async () => {
    const { instance, credentials } = await startInstance({ ai: true });
    try {
      expect(instance.port).not.toBe(3000);
      expect(existsSync(instance.runDir)).toBe(true);
      const login = await fetch(`${instance.url}/api/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: credentials.owner?.email,
          password: credentials.owner?.password,
        }),
      });
      expect(login.status).toBe(200);
      expect(listInstances().some((i) => i.id === instance.id && i.running)).toBe(true);
    } finally {
      await stopInstance(instance.id);
    }
    expect(existsSync(instance.runDir)).toBe(false);
    await expect(fetch(`${instance.url}/api/health`)).rejects.toThrow();
  });
});
