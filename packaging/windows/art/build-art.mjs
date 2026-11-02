// The installer's pictures (WixUI banner and dialog bitmaps), drawn from banner.svg and dialog.svg
// next to this file. Run after changing a drawing and commit the results:
//
//   node packaging/windows/art/build-art.mjs [--preview <folder>]
//
// Needs the UI's dependencies (`npm ci` in ui/) and Playwright's Chromium, which draws each SVG.
// Windows Installer stretches a bitmap to its control, whose size grows with the display scale, so
// the pictures are drawn at twice the size: sharp at 200 %, and scaled down at 100 %, 125 % and
// 150 %. Writes banner.bmp and dialog.bmp (24 bit, the format WiX embeds) and, with --preview,
// a PNG of each to look at; changes nothing else.

import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..", "..");
const require = createRequire(join(root, "ui", "package.json"));
const { chromium } = require("@playwright/test");

/** Each picture at 100 % (the size WixUI documents) and the factor it is drawn at. */
const PICTURES = [
  { name: "banner", width: 493, height: 58 },
  { name: "dialog", width: 493, height: 312 },
];
const SCALE = 2;

/** A bottom-up 24 bit BMP from RGBA pixels, rows padded to four bytes. */
function bmp(rgba, width, height) {
  const row = Math.ceil((width * 3) / 4) * 4;
  const size = 54 + row * height;
  const out = Buffer.alloc(size);
  out.write("BM", 0, "ascii");
  out.writeUInt32LE(size, 2);
  out.writeUInt32LE(54, 10);
  out.writeUInt32LE(40, 14);
  out.writeInt32LE(width, 18);
  out.writeInt32LE(height, 22);
  out.writeUInt16LE(1, 26);
  out.writeUInt16LE(24, 28);
  out.writeUInt32LE(row * height, 34);
  // 96 dpi; Windows Installer ignores it and stretches to the control.
  out.writeInt32LE(3780, 38);
  out.writeInt32LE(3780, 42);
  for (let y = 0; y < height; y++) {
    const target = 54 + (height - 1 - y) * row;
    for (let x = 0; x < width; x++) {
      const source = (y * width + x) * 4;
      out[target + x * 3] = rgba[source + 2];
      out[target + x * 3 + 1] = rgba[source + 1];
      out[target + x * 3 + 2] = rgba[source];
    }
  }
  return out;
}

const preview = process.argv.indexOf("--preview");
const previewDir = preview === -1 ? null : process.argv[preview + 1];

const browser = await chromium.launch();
try {
  const page = await browser.newPage();
  for (const { name, width, height } of PICTURES) {
    const svg = readFileSync(join(here, `${name}.svg`), "utf8");
    const w = width * SCALE;
    const h = height * SCALE;
    // The SVG is drawn into a canvas of the target size: opaque, no color management, and the
    // pixels come back as they are.
    const pixels = await page.evaluate(
      async ({ svg, w, h }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const context = canvas.getContext("2d", { alpha: false });
        context.drawImage(image, 0, 0, w, h);
        const data = context.getImageData(0, 0, w, h).data;
        let binary = "";
        for (let i = 0; i < data.length; i += 0x8000) {
          binary += String.fromCharCode(...data.subarray(i, i + 0x8000));
        }
        return { rgba: btoa(binary), png: canvas.toDataURL("image/png") };
      },
      { svg, w, h },
    );
    const file = join(here, `${name}.bmp`);
    writeFileSync(file, bmp(Buffer.from(pixels.rgba, "base64"), w, h));
    console.log(`wrote ${file} (${w} x ${h})`);
    if (previewDir) {
      const png = join(previewDir, `${name}.png`);
      writeFileSync(png, Buffer.from(pixels.png.split(",")[1], "base64"));
      console.log(`wrote ${png}`);
    }
  }
} finally {
  await browser.close();
}
