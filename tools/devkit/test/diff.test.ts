import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PNG } from "pngjs";
import { afterAll, describe, expect, it } from "vitest";
import { scoreImages, visualDiff } from "../src/diff.ts";

function image(
  width: number,
  height: number,
  paint?: (x: number, y: number) => number[] | undefined,
): PNG {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      png.data[i] = r ?? 255;
      png.data[i + 1] = g ?? 255;
      png.data[i + 2] = b ?? 255;
      png.data[i + 3] = 255;
    }
  }
  return png;
}

describe("scoreImages", () => {
  it("scores identical images 0", () => {
    const r = scoreImages(image(20, 10), image(20, 10));
    expect(r.changedPixels).toBe(0);
    expect(r.score).toBe(0);
    expect(r.sizeChanged).toBe(false);
  });

  it("counts a changed block as its share of all pixels", () => {
    const after = image(20, 10, (x, y) => (x < 5 && y < 4 ? [0, 0, 0] : undefined));
    const r = scoreImages(image(20, 10), after);
    expect(r.changedPixels).toBe(20);
    expect(r.score).toBeCloseTo(20 / 200);
  });

  it("ignores a color shift below the threshold", () => {
    const after = image(20, 10, () => [250, 250, 250]);
    expect(scoreImages(image(20, 10), after, 0.1).changedPixels).toBe(0);
    expect(scoreImages(image(20, 10), after, 0).changedPixels).toBe(200);
  });

  it("counts the area only one image covers when the sizes differ", () => {
    const r = scoreImages(image(10, 10), image(10, 12));
    expect(r.sizeChanged).toBe(true);
    expect(r.changedPixels).toBe(20);
  });
});

describe("visualDiff", () => {
  const root = mkdtempSync(join(tmpdir(), "devkit-diff-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it("lists changed, added and removed screens and writes the reports", () => {
    const before = join(root, "before");
    const after = join(root, "after");
    mkdirSync(before);
    mkdirSync(after);
    const write = (dir: string, name: string, png: PNG) =>
      writeFileSync(join(dir, name), PNG.sync.write(png));
    write(before, "same.png", image(30, 30));
    write(after, "same.png", image(30, 30));
    write(before, "home.png", image(30, 30));
    write(
      after,
      "home.png",
      image(30, 30, (x) => (x < 10 ? [0, 0, 0] : undefined)),
    );
    write(before, "gone.png", image(5, 5));
    write(after, "new.png", image(5, 5));
    const report = visualDiff({ before, after, out: join(root, "out") });
    expect(report.changed).toBe(1);
    expect(report.unchanged).toBe(1);
    expect(report.added).toBe(1);
    expect(report.removed).toBe(1);
    expect(report.entries[0]?.file).toBe("home.png");
    expect(report.entries[0]?.diffImage).toBeDefined();
    expect(readFileSync(report.markdown, "utf8")).toContain("| home.png | changed |");
    expect(readFileSync(report.html, "utf8")).toContain("home.png");
  });
});
