import { describe, expect, it } from "vitest";
import { commandLine, mapAffected, type RepoView, rustFilter } from "../src/affected.ts";

const CONTENTS: Record<string, string> = {
  "server/Cargo.toml": '[package]\nname = "kalzit"\n',
  "plugin-sdk/Cargo.toml": '[package]\nname = "kalzit-plugin-sdk"\n',
  "server/tests/ai.rs": "",
  "server/tests/ai_chat.rs": "",
  "server/tests/scim.rs": "",
  "server/tests/api.rs": "",
  "ui/src/panels/bar/BarPanel.tsx": "",
  "ui/src/panels/bar/BarPanel.test.tsx": 'import { BarPanel } from "./BarPanel";',
  "ui/src/panels/viz.test.tsx": 'import { BarPanel } from "./bar/BarPanel.tsx";',
  "ui/src/panels/other.test.tsx": 'import { x } from "./other";',
  "ui/src/i18n/en/common.json": "{}",
  "ui/src/i18n/i18n.test.ts": "",
  "ui/src/features/dashboards/DashboardPage.tsx": "",
  "ui/src/features/dashboards/DashboardPage.test.tsx": 'import { D } from "./DashboardPage";',
  "ui/e2e/dashboards.spec.ts": "",
  "ui/e2e/graph.spec.ts": 'import { serviceAddress } from "./support/services";',
  "ui/e2e/layout.spec.ts": "",
  "ui/e2e/a11y.spec.ts": "",
  "ui/e2e/support/services.ts": "",
};

const repo: RepoView = { files: Object.keys(CONTENTS), read: (path) => CONTENTS[path] ?? "" };

const kinds = (paths: string[]) =>
  mapAffected(paths, repo).commands.map((c) => [c.kind, c.args.join(" ")]);

describe("rustFilter", () => {
  it("turns a source path into a module filter", () => {
    expect(rustFilter("server/src/ai/chat.rs")).toBe("ai::chat");
    expect(rustFilter("server/src/dashboards/mod.rs")).toBe("dashboards");
    expect(rustFilter("server/src/lib.rs")).toBeUndefined();
  });
});

describe("mapAffected", () => {
  it("maps a server module to its unit tests and the integration tests named after it", () => {
    expect(kinds(["server/src/ai/chat.rs"])).toEqual([
      ["cargo", "test --locked -p kalzit --test ai --test ai_chat"],
      ["cargo", "test --locked -p kalzit --lib -- ai::chat"],
    ]);
  });

  it("runs a changed integration test file by itself", () => {
    expect(kinds(["server/tests/scim.rs"])).toEqual([
      ["cargo", "test --locked -p kalzit --test scim"],
    ]);
  });

  it("runs the whole package for migrations and other crates, the workspace for the lock file", () => {
    expect(kinds(["server/migrations/sqlite/0042.sql"])).toEqual([
      ["cargo", "test --locked -p kalzit"],
    ]);
    expect(kinds(["plugin-sdk/src/lib.rs"])).toEqual([
      ["cargo", "test --locked -p kalzit-plugin-sdk"],
    ]);
    expect(kinds(["Cargo.lock", "server/src/ai/chat.rs"])).toEqual([
      ["cargo", "test --locked --workspace"],
    ]);
  });

  it("maps a UI file to the tests that import it or sit next to it", () => {
    expect(kinds(["ui/src/panels/bar/BarPanel.tsx"])).toEqual([
      [
        "vitest",
        "vitest run --maxWorkers=2 src/panels/bar/BarPanel.test.tsx src/panels/viz.test.tsx",
      ],
    ]);
  });

  it("maps a feature folder to its Playwright spec", () => {
    const commands = mapAffected(["ui/src/features/dashboards/DashboardPage.tsx"], repo).commands;
    expect(commands.map((c) => c.kind)).toEqual(["vitest", "playwright"]);
    expect(commands[1]?.args).toContain("e2e/dashboards.spec.ts");
    expect(commands[1]?.args).toContain("--workers=2");
  });

  it("maps catalogs to the i18n tests, styles to the layout and accessibility specs", () => {
    expect(kinds(["ui/src/i18n/en/common.json"])).toEqual([
      ["vitest", "vitest run --maxWorkers=2 src/i18n/i18n.test.ts"],
    ]);
    const css = mapAffected(["ui/src/panels/panels.css"], repo).commands[0];
    expect(css?.args.slice(-2)).toEqual(["e2e/a11y.spec.ts", "e2e/layout.spec.ts"]);
  });

  it("maps an e2e support file to the specs that import it", () => {
    const c = mapAffected(["ui/e2e/support/services.ts"], repo).commands[0];
    expect(c?.args.at(-1)).toBe("e2e/graph.spec.ts");
  });

  it("lists paths no rule covers", () => {
    expect(mapAffected(["docs/PLAN.md"], repo).uncovered).toEqual(["docs/PLAN.md"]);
  });

  it("writes runnable command lines with the load limits", () => {
    const [cargo] = mapAffected(["server/tests/scim.rs"], repo).commands;
    expect(cargo === undefined ? "" : commandLine(cargo)).toBe(
      "CARGO_BUILD_JOBS=2 cargo test --locked -p kalzit --test scim",
    );
  });
});
