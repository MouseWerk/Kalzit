import { readFile } from "node:fs/promises";
import type { Page } from "@playwright/test";
import { Api, unique } from "./support/api";
import { t } from "./support/i18n";
import { expect, signInOwner, test } from "./support/test";

/**
 * "Export as image" in a real browser, pixel by pixel: the picture of a panel is square and has
 * no frame. An opaque panel is filled with its own colour to the corners and along every edge
 * (no border line of the card, no rounded corner); a transparent panel gives a transparent PNG.
 */

const OPAQUE = "Filled notes";
const CLEAR = "Clear notes";

type Pixel = [number, number, number, number];

interface Sampled {
  width: number;
  height: number;
  corners: Pixel[];
  edges: Pixel[];
  /** The panel card's own background colour on screen, as a pixel. */
  card: Pixel;
}

/** Saves the image of the panel titled `title` and reads its corner and mid-edge pixels. */
async function exported(page: Page, title: string): Promise<Sampled> {
  const card = page.getByRole("article", { name: title, exact: true });
  // The menu button shows on hover or focus; the keyboard reaches it without hovering the panel.
  const button = card.getByRole("button", { name: t("dashboards.panel.menuNamed", { title }) });
  await button.focus();
  await button.press("Enter");
  const download = page.waitForEvent("download");
  await page.getByRole("menuitem", { name: t("dashboards.panel.imageNamed", { title }) }).click();
  const png = await readFile(await (await download).path());
  expect([...png.subarray(0, 8)]).toEqual([137, 80, 78, 71, 13, 10, 26, 10]);
  return await card.evaluate(async (element, base64) => {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }), {
      premultiplyAlpha: "none",
    });
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    context.drawImage(bitmap, 0, 0);
    const at = (x: number, y: number) =>
      [...context.getImageData(x, y, 1, 1).data] as [number, number, number, number];
    const [right, bottom] = [width - 1, height - 1];
    const [midX, midY] = [Math.floor(width / 2), Math.floor(height / 2)];
    const swatch = new OffscreenCanvas(1, 1).getContext("2d") as OffscreenCanvasRenderingContext2D;
    swatch.fillStyle = getComputedStyle(element).backgroundColor;
    swatch.fillRect(0, 0, 1, 1);
    return {
      width,
      height,
      corners: [at(0, 0), at(right, 0), at(0, bottom), at(right, bottom)],
      edges: [at(midX, 0), at(midX, bottom), at(0, midY), at(right, midY)],
      card: [...swatch.getImageData(0, 0, 1, 1).data] as [number, number, number, number],
    };
  }, png.toString("base64"));
}

test("the image of a panel is square and frameless; a transparent panel stays transparent", async ({
  page,
}) => {
  const owner = await Api.owner();
  const notes = (id: string, title: string, x: number, more: Record<string, unknown> = {}) => ({
    id,
    type: "text",
    title,
    grid: { x, y: 0, w: 12, h: 6 },
    targets: [],
    options: { mode: "markdown", content: "Quarterly notes." },
    ...more,
  });
  const id = await owner.createDashboard({
    schemaVersion: 1,
    title: unique("Bilder"),
    timeRange: { from: "now-6h", to: "now" },
    variables: [],
    panels: [notes("filled", OPAQUE, 0), notes("clear", CLEAR, 12, { transparent: true })],
  });
  await owner.dispose();
  await signInOwner(page);
  await page.goto(`/dashboards/${id}`);
  await expect(page.getByRole("article", { name: OPAQUE, exact: true })).toContainText(
    "Quarterly notes.",
  );
  await expect(page.getByRole("article", { name: CLEAR, exact: true })).toContainText(
    "Quarterly notes.",
  );

  await test.step("an opaque panel: its own colour in every corner and along every edge", async () => {
    const image = await exported(page, OPAQUE);
    // The card has an opaque colour of its own; the picture is filled with exactly that.
    expect(image.card[3]).toBe(255);
    for (const pixel of [...image.corners, ...image.edges]) {
      expect(pixel[3]).toBe(255);
      for (const channel of [0, 1, 2]) {
        // No border line of the card and no other colour around a rounded corner.
        expect(Math.abs((pixel[channel] ?? 0) - (image.card[channel] ?? 0))).toBeLessThanOrEqual(2);
      }
    }
  });

  await test.step("a transparent panel: nothing painted in the corners or along the edges", async () => {
    const image = await exported(page, CLEAR);
    expect(image.card[3]).toBe(0);
    for (const pixel of [...image.corners, ...image.edges]) {
      expect(pixel[3]).toBe(0);
    }
  });
});
