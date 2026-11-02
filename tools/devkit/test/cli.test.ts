import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/cli.ts";
import { TOOLS, type ToolDef } from "../src/tools.ts";

const def = (name: string) => (TOOLS as readonly ToolDef[]).find((t) => t.name === name) as ToolDef;

describe("parseArgs", () => {
  it("reads positional arguments, lists, numbers and booleans", () => {
    expect(parseArgs(def("visual_diff"), ["a", "b", "--threshold", "0.2"])).toEqual({
      before: "a",
      after: "b",
      threshold: 0.2,
    });
    expect(
      parseArgs(def("capture_screens"), [
        "--widths",
        "1440,1024",
        "--widths=800",
        "--locales",
        "de",
        "--full-page",
      ]),
    ).toEqual({ widths: [1440, 1024, 800], locales: ["de"], fullPage: true });
    expect(parseArgs(def("instance_start"), ["--graph", "--no-seed"])).toEqual({
      graph: true,
      seed: false,
    });
    expect(parseArgs(def("merge_pr"), ["181"])).toEqual({ pr: 181 });
  });

  it("refuses unknown options", () => {
    expect(() => parseArgs(def("instance_list"), ["--port", "3000"])).toThrow(/unknown option/);
  });
});
