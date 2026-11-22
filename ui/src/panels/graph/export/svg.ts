import type { Op, Picture } from "./picture";

/**
 * A picture as an SVG document: vector shapes, and every text as text (searchable, editable,
 * sharp at any size). Everything is styled with presentation attributes; the file carries no
 * script, no link and no reference to another file, so it shows the same wherever it is opened or
 * embedded. `fontCss` (the page's own `@font-face` rules with their files embedded) makes it use
 * Kalzit's font where the reader has none of that name; without it, or in a program that ignores
 * it, the font list's fallbacks apply.
 */

const SVG_NS = "http://www.w3.org/2000/svg";

/** Text for XML: the special characters as entities; what XML 1.0 cannot hold becomes U+FFFD. */
export function xmlText(text: string): string {
  let out = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (code === 0x9 || code === 0xa || code === 0xd) out += `&#${code};`;
    else if (
      code < 0x20 ||
      code === 0xfffe ||
      code === 0xffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      out += "�";
    else out += char;
  }
  return out;
}

/** A number as SVG writes it: two decimals at most, no trailing zeros. */
function n(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  return Object.is(rounded, -0) || !Number.isFinite(rounded) ? "0" : String(rounded);
}

function opSvg(op: Op, boldWeight: string): string {
  switch (op.kind) {
    case "rect":
      return `<rect x="${n(op.x)}" y="${n(op.y)}" width="${n(op.width)}" height="${n(op.height)}" fill="${xmlText(op.fill)}"/>`;
    case "circle":
      return `<circle cx="${n(op.cx)}" cy="${n(op.cy)}" r="${n(op.r)}" fill="${xmlText(op.fill)}"/>`;
    case "ring":
      return `<circle cx="${n(op.cx)}" cy="${n(op.cy)}" r="${n(op.r)}" fill="none" stroke="${xmlText(op.stroke)}" stroke-width="${n(op.width)}"/>`;
    case "polygon": {
      const points: string[] = [];
      for (let i = 0; i + 1 < op.points.length; i += 2) {
        points.push(`${n(op.points[i] ?? 0)},${n(op.points[i + 1] ?? 0)}`);
      }
      return `<polygon points="${points.join(" ")}" fill="${xmlText(op.fill)}"/>`;
    }
    case "line":
      return `<line x1="${n(op.x1)}" y1="${n(op.y1)}" x2="${n(op.x2)}" y2="${n(op.y2)}" stroke="${xmlText(op.stroke)}" stroke-width="${n(op.width)}"/>`;
    case "text": {
      const weight = op.bold ? ` font-weight="${xmlText(boldWeight)}"` : "";
      const anchor = op.anchor === "middle" ? ' text-anchor="middle"' : "";
      return `<text x="${n(op.x)}" y="${n(op.y)}" font-size="${n(op.size)}" fill="${xmlText(op.fill)}"${weight}${anchor} xml:space="preserve">${xmlText(op.text)}</text>`;
    }
  }
}

export function pictureSvg(picture: Picture, fontCss = ""): string {
  const { width, height } = picture;
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="${SVG_NS}" width="${n(width)}" height="${n(height)}" viewBox="0 0 ${n(width)} ${n(height)}" role="img" font-family="${xmlText(picture.font)}">`,
    `<title>${xmlText(picture.title)}</title>`,
  ];
  const defs: string[] = [];
  if (fontCss !== "") {
    defs.push(`<style><![CDATA[${fontCss.split("]]>").join("]]]]><![CDATA[>")}]]></style>`);
  }
  picture.layers.forEach((layer, i) => {
    if (layer.clip === null) return;
    const { x, y, width: w, height: h } = layer.clip;
    defs.push(
      `<clipPath id="clip-${i}"><rect x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}"/></clipPath>`,
    );
  });
  if (defs.length > 0) lines.push(`<defs>${defs.join("")}</defs>`);
  if (picture.background !== null) {
    lines.push(
      `<rect width="${n(width)}" height="${n(height)}" fill="${xmlText(picture.background)}"/>`,
    );
  }
  picture.layers.forEach((layer, i) => {
    const clip = layer.clip === null ? "" : ` clip-path="url(#clip-${i})"`;
    lines.push(`<g id="${xmlText(layer.name)}"${clip}>`);
    for (const op of layer.ops) lines.push(opSvg(op, picture.boldWeight));
    lines.push("</g>");
  });
  lines.push("</svg>");
  return `${lines.join("\n")}\n`;
}
