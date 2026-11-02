// The product icons of Kalzit, drawn from one mark: the favicon, the PWA and Apple touch icons and
// the Windows icon (program and installer). Run after changing the mark or a size:
//
//   node tools/brand/build-icons.mjs
//
// Needs the UI's dependencies (`npm ci` in ui/) and Playwright's Chromium, which renders each size
// from its own drawing: small sizes get a heavier stroke and less padding, so the mark stays crisp
// at 16 and 32 px instead of being a scaled-down 256 px picture. Writes the files it lists and
// changes nothing else; commit the results.

import { mkdirSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const require = createRequire(join(root, "ui", "package.json"));
const { chromium } = require("@playwright/test");

/**
 * The Kalzit mark: a calcite rhombohedron with three visible faces, on a 24 unit grid, centered on
 * 12,12. The same path as `logo` in ui/src/components/Icon.tsx.
 */
export const MARK =
  "M3.1 8.25 7.6 3.95l11.5-2 1.8 13.6-4 4.4L5.6 22.05ZM3.1 8.25 14.6 6.35l2.3 13.6M14.6 6.35l4.5-4.4";

/** The ink and paper of the brand: the tile and the mark on it. */
const INK = "#2a2520";
const PAPER = "#f0ece6";

/**
 * One drawing per size. `scale` is the mark's size on the tile, `stroke` the line in grid units,
 * `radius` the tile's corner (0 for a full square that the platform masks itself).
 */
function tile({ scale, stroke, radius }) {
  const corner = radius === 0 ? "" : ` rx="${radius}"`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24">
  <rect width="24" height="24"${corner} fill="${INK}"/>
  <g transform="translate(12 12) scale(${scale}) translate(-12 -12)" fill="none" stroke="${PAPER}" stroke-width="${stroke}" stroke-linecap="round" stroke-linejoin="round">
    <path d="${MARK}"/>
  </g>
</svg>
`;
}

/**
 * The mark hinted for 16 px: the same three faces, the long edges on whole pixels and one pixel
 * wide, since the tilted drawing blurs into grey at this size.
 */
const PIXEL_16 = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
  <rect width="16" height="16" rx="3" fill="${INK}"/>
  <path d="M2.5 5.5h8v8h-8zM2.5 5.5l3-3h8l-3 3M13.5 2.5v8l-3 3" fill="none" stroke="${PAPER}" stroke-width="1" stroke-linecap="square" stroke-linejoin="miter"/>
</svg>
`;

// Strokes in grid units after scaling: 20 px about 1.3 px, 32 px about 2 px, 48 px about 2.6 px,
// from 128 px on about 1/22 of the tile.
const APP = {
  16: { scale: 0.92, stroke: 2.1, radius: 3 },
  20: { scale: 0.86, stroke: 2.2, radius: 3.5 },
  24: { scale: 0.8, stroke: 2.2, radius: 4 },
  32: { scale: 0.72, stroke: 2.1, radius: 5 },
  48: { scale: 0.7, stroke: 1.9, radius: 5.25 },
  64: { scale: 0.68, stroke: 1.8, radius: 5.25 },
  128: { scale: 0.66, stroke: 1.65, radius: 5.25 },
  256: { scale: 0.66, stroke: 1.6, radius: 5.25 },
};
const LARGE = APP[256];

/** The favicon: the bare mark in the page's scheme, as the browser tab shows it. */
const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="${INK}" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
  <title>Kalzit</title>
  <style>
    @media (prefers-color-scheme: dark) { svg { stroke: ${PAPER}; } }
  </style>
  <path d="${MARK}"/>
</svg>
`;

/** An ICO file with PNG images (Windows Vista and later read them at every size). */
function ico(images) {
  const header = Buffer.alloc(6 + 16 * images.length);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = header.length;
  images.forEach(({ size, png }, index) => {
    const at = 6 + 16 * index;
    header.writeUInt8(size >= 256 ? 0 : size, at);
    header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt8(0, at + 2);
    header.writeUInt8(0, at + 3);
    header.writeUInt16LE(1, at + 4);
    header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8);
    header.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  return Buffer.concat([header, ...images.map((image) => image.png)]);
}

function write(path, data) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, data);
  console.log(path);
}

const browser = await chromium.launch();
async function render(svg, size) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img style="display:block;width:${size}px;height:${size}px" src="data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}"></body></html>`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  return png;
}

const app = {};
for (const size of Object.keys(APP).map(Number)) {
  app[size] = await render(size === 16 ? PIXEL_16 : tile(APP[size]), size);
}

// Web: the favicon (SVG for current browsers, ICO for the rest), the PWA icons, Apple's touch icon.
write("ui/public/favicon.svg", FAVICON);
write("ui/public/favicon.ico", ico([16, 32, 48].map((size) => ({ size, png: app[size] }))));
write("ui/public/icon-192.png", await render(tile({ ...LARGE, scale: 0.66 }), 192));
write("ui/public/icon-512.png", await render(tile(LARGE), 512));
// Maskable: the full square, the mark inside the safe circle (80 % of the width).
write("ui/public/icon-maskable-512.png", await render(tile({ ...LARGE, scale: 0.52, radius: 0 }), 512));
// iOS rounds the corners itself and fills transparent pixels with black.
write("ui/public/apple-touch-icon.png", await render(tile({ ...LARGE, scale: 0.6, radius: 0 }), 180));

// Windows: kalzit.exe (server/build.rs) and the MSI's entry in Apps (packaging/windows).
write(
  "packaging/windows/kalzit.ico",
  ico([16, 20, 24, 32, 48, 64, 128, 256].map((size) => ({ size, png: app[size] }))),
);

await browser.close();
