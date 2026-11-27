import type { Op, Picture } from "./picture";

/**
 * A picture as a one-page PDF, written here without a library: the shapes are vector paths and
 * the texts are text in Helvetica, one of the fonts every PDF reader brings along, so no font is
 * embedded and the file stays a few kilobytes. Helvetica covers Western European text (the
 * Windows-1252 characters); a text with any other character (Cyrillic, Greek, CJK, emoji) is put
 * in as a small image of itself instead, drawn by the browser (`rasterText`).
 *
 * Why not a library: jsPDF with svg2pdf or pdf-lib would add 300 to 500 kB of script for what a
 * graph picture needs of PDF, which is filled paths, lines, clipping and text.
 */

/** A text as an image: its pixels, and the size and place it takes in the picture, in px. */
export interface TextImage {
  /** Pixels across and down. */
  pixelWidth: number;
  pixelHeight: number;
  /** `pixelWidth * pixelHeight * 3` bytes of red, green, blue. */
  rgb: Uint8Array;
  /** `pixelWidth * pixelHeight` bytes: how opaque each pixel is. */
  alpha: Uint8Array;
  /** The image's size in the picture, and how far its top is above the text's baseline. */
  width: number;
  height: number;
  ascent: number;
}

export interface PdfOptions {
  /** One page of the picture's size, or A4 landscape with the picture fitted onto it. */
  page: "fit" | "a4";
  /** Draws a text Helvetica cannot write; without it such characters become "?". */
  rasterText?: (op: Extract<Op, { kind: "text" }>) => TextImage | null;
}

/** The most text images one file holds; further texts Helvetica cannot write become "?". */
export const MAX_TEXT_IMAGES = 2000;

/** CSS px to PDF points. */
const PT = 0.75;
const A4 = { width: 841.89, height: 595.28 };
const A4_MARGIN = 28;
/** On A4 a small picture is drawn at most this much larger than its own size. */
const A4_MAX_SCALE = 1.5 * PT;

/** Windows-1252's characters between 0x80 and 0x9F, by Unicode code point. */
const CP1252: Readonly<Record<number, number>> = {
  8364: 0x80,
  8218: 0x82,
  402: 0x83,
  8222: 0x84,
  8230: 0x85,
  8224: 0x86,
  8225: 0x87,
  710: 0x88,
  8240: 0x89,
  352: 0x8a,
  8249: 0x8b,
  338: 0x8c,
  381: 0x8e,
  8216: 0x91,
  8217: 0x92,
  8220: 0x93,
  8221: 0x94,
  8226: 0x95,
  8211: 0x96,
  8212: 0x97,
  732: 0x98,
  8482: 0x99,
  353: 0x9a,
  8250: 0x9b,
  339: 0x9c,
  382: 0x9e,
  376: 0x9f,
};

/** A character's byte in Windows-1252, or null when the encoding has none for it. */
function winAnsi(code: number): number | null {
  if (code >= 0x20 && code <= 0x7e) return code;
  if (code >= 0xa0 && code <= 0xff) return code;
  // Control characters (tabs and line breaks included) are a space in a one-line label.
  if (code < 0x20 || code === 0x7f) return 0x20;
  return CP1252[code] ?? null;
}

/** Whether Helvetica (Windows-1252) can write every character of the text. */
export function isWinAnsi(text: string): boolean {
  for (const char of text) {
    if (winAnsi(char.codePointAt(0) ?? 0) === null) return false;
  }
  return true;
}

/** The text as a PDF hex string in Windows-1252; a character without a byte becomes "?". */
function hexText(text: string): string {
  let out = "<";
  for (const char of text) {
    const byte = winAnsi(char.codePointAt(0) ?? 0) ?? 0x3f;
    out += byte.toString(16).padStart(2, "0");
  }
  return `${out}>`;
}

/** A text for the document's properties, as UTF-16BE with a byte order mark. */
function unicodeText(text: string): string {
  let out = "<feff";
  for (let i = 0; i < text.length; i++) {
    out += text.charCodeAt(i).toString(16).padStart(4, "0");
  }
  return `${out}>`;
}

/** A CSS color as red, green and blue from 0 to 1: `#rgb`, `#rrggbb` or `rgb(...)`; else black. */
export function pdfColor(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim())?.[1];
  if (hex !== undefined) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    const part = (i: number) => Number.parseInt(full.slice(i, i + 2), 16) / 255;
    return [part(0), part(2), part(4)];
  }
  const rgb = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color.trim());
  if (rgb !== null) {
    const part = (i: number) => Math.min(255, Number(rgb[i] ?? 0)) / 255;
    return [part(1), part(2), part(3)];
  }
  return [0, 0, 0];
}

/** A number as PDF writes it: three decimals at most, never an exponent. */
function n(value: number): string {
  if (!Number.isFinite(value)) return "0";
  const text = value.toFixed(3).replace(/\.?0+$/, "");
  return text === "-0" || text === "" ? "0" : text;
}

function fill(color: string): string {
  return `${pdfColor(color).map(n).join(" ")} rg`;
}

function stroke(color: string): string {
  return `${pdfColor(color).map(n).join(" ")} RG`;
}

/** A circle as four curves. */
function circlePath(cx: number, cy: number, r: number): string {
  const k = 0.5522847498 * r;
  return [
    `${n(cx + r)} ${n(cy)} m`,
    `${n(cx + r)} ${n(cy + k)} ${n(cx + k)} ${n(cy + r)} ${n(cx)} ${n(cy + r)} c`,
    `${n(cx - k)} ${n(cy + r)} ${n(cx - r)} ${n(cy + k)} ${n(cx - r)} ${n(cy)} c`,
    `${n(cx - r)} ${n(cy - k)} ${n(cx - k)} ${n(cy - r)} ${n(cx)} ${n(cy - r)} c`,
    `${n(cx + k)} ${n(cy - r)} ${n(cx + r)} ${n(cy - k)} ${n(cx + r)} ${n(cy)} c`,
  ].join("\n");
}

const encoder = new TextEncoder();

/** zlib-compressed bytes (PDF's FlateDecode), or null where the browser cannot compress. */
async function deflate(bytes: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === "undefined") return null;
  try {
    const stream = new Blob([bytes as BlobPart])
      .stream()
      .pipeThrough(new CompressionStream("deflate"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** A stream object's bytes: its dictionary (with the length and the filter) and its data. */
async function streamObject(dictionary: string, data: Uint8Array): Promise<Uint8Array> {
  const packed = await deflate(data);
  const body = packed ?? data;
  const filter = packed === null ? "" : " /Filter /FlateDecode";
  const head = encoder.encode(`<< ${dictionary} /Length ${body.length}${filter} >>\nstream\n`);
  const tail = encoder.encode("\nendstream");
  const out = new Uint8Array(head.length + body.length + tail.length);
  out.set(head, 0);
  out.set(body, head.length);
  out.set(tail, head.length + body.length);
  return out;
}

/**
 * The picture as a PDF file. The texts' widths (`Op.width`) must have been measured in Helvetica
 * for texts it can write (measure.ts), so centred texts sit where they should.
 */
export async function picturePdf(picture: Picture, options: PdfOptions): Promise<Uint8Array> {
  const fitted = options.page === "fit";
  const page = fitted ? { width: picture.width * PT, height: picture.height * PT } : A4;
  const scale = fitted
    ? PT
    : Math.min(
        A4_MAX_SCALE,
        (A4.width - 2 * A4_MARGIN) / picture.width,
        (A4.height - 2 * A4_MARGIN) / picture.height,
      );
  const left = (page.width - picture.width * scale) / 2;
  const top = (page.height - picture.height * scale) / 2;
  const images: TextImage[] = [];
  // The same text in the same style (a label many nodes share) is one image, drawn again.
  const imageOf = new Map<string, number>();
  const content: string[] = [];
  if (picture.background !== null) {
    // The whole page, so an A4 page has one color around the picture too.
    content.push(`${fill(picture.background)}\n0 0 ${n(page.width)} ${n(page.height)} re f`);
  }
  // From here on the picture's own px, counted from its top left, y downwards.
  content.push(`${n(scale)} 0 0 ${n(-scale)} ${n(left)} ${n(page.height - top)} cm`);
  for (const layer of picture.layers) {
    content.push("q");
    if (layer.clip !== null) {
      const { x, y, width, height } = layer.clip;
      content.push(`${n(x)} ${n(y)} ${n(width)} ${n(height)} re W n`);
    }
    for (const op of layer.ops) {
      switch (op.kind) {
        case "rect":
          content.push(
            `${fill(op.fill)}\n${n(op.x)} ${n(op.y)} ${n(op.width)} ${n(op.height)} re f`,
          );
          break;
        case "circle":
          content.push(`${fill(op.fill)}\n${circlePath(op.cx, op.cy, op.r)}\nf`);
          break;
        case "ring":
          content.push(
            `${stroke(op.stroke)}\n${n(op.width)} w\n${circlePath(op.cx, op.cy, op.r)}\nS`,
          );
          break;
        case "polygon": {
          const parts: string[] = [];
          for (let i = 0; i + 1 < op.points.length; i += 2) {
            parts.push(
              `${n(op.points[i] ?? 0)} ${n(op.points[i + 1] ?? 0)} ${i === 0 ? "m" : "l"}`,
            );
          }
          content.push(`${fill(op.fill)}\n${parts.join("\n")}\nh f`);
          break;
        }
        case "line":
          content.push(
            `${stroke(op.stroke)}\n${n(op.width)} w\n${n(op.x1)} ${n(op.y1)} m\n${n(op.x2)} ${n(op.y2)} l\nS`,
          );
          break;
        case "text": {
          const x = op.anchor === "middle" ? op.x - op.width / 2 : op.x;
          let at = -1;
          if (!isWinAnsi(op.text)) {
            const key = `${op.text}|${op.bold}|${op.size}|${op.fill}`;
            at = imageOf.get(key) ?? -1;
            if (at < 0 && images.length < MAX_TEXT_IMAGES) {
              const made = options.rasterText?.(op) ?? null;
              if (made !== null) {
                at = images.length;
                images.push(made);
                imageOf.set(key, at);
              }
            }
          }
          const image = at < 0 ? undefined : images[at];
          if (image !== undefined) {
            const y = op.y - image.ascent;
            content.push(
              `q
${n(image.width)} 0 0 ${n(-image.height)} ${n(x)} ${n(y + image.height)} cm
/Im${at} Do
Q`,
            );
            break;
          }
          // The page is flipped (y downwards), so the text is flipped back.
          content.push(
            `BT\n/${op.bold ? "F2" : "F1"} ${n(op.size)} Tf\n${fill(op.fill)}\n1 0 0 -1 ${n(x)} ${n(op.y)} Tm\n${hexText(op.text)} Tj\nET`,
          );
          break;
        }
      }
    }
    content.push("Q");
  }

  // Objects 1 to 7 are fixed; each image takes two more (its colors and its opacity).
  const objects: Uint8Array[] = [];
  const text = (value: string) => encoder.encode(value);
  const firstImage = 8;
  const xobjects = images.map((_, i) => `/Im${i} ${firstImage + 2 * i} 0 R`).join(" ");
  objects.push(text("<< /Type /Catalog /Pages 2 0 R >>"));
  objects.push(text("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"));
  objects.push(
    text(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(page.width)} ${n(page.height)}] /Contents 4 0 R ` +
        `/Resources << /Font << /F1 5 0 R /F2 6 0 R >>${xobjects === "" ? "" : ` /XObject << ${xobjects} >>`} >> >>`,
    ),
  );
  objects.push(await streamObject("", text(`${content.join("\n")}\n`)));
  for (const name of ["Helvetica", "Helvetica-Bold"]) {
    objects.push(
      text(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`),
    );
  }
  objects.push(text(`<< /Title ${unicodeText(picture.title)} /Producer (Kalzit) >>`));
  for (const [i, image] of images.entries()) {
    const size = `/Type /XObject /Subtype /Image /Width ${image.pixelWidth} /Height ${image.pixelHeight} /BitsPerComponent 8`;
    objects.push(
      await streamObject(
        `${size} /ColorSpace /DeviceRGB /SMask ${firstImage + 2 * i + 1} 0 R`,
        image.rgb,
      ),
    );
    objects.push(await streamObject(`${size} /ColorSpace /DeviceGray`, image.alpha));
  }

  // The file: a header, the objects, the table of where each starts, and the trailer.
  const chunks: Uint8Array[] = [
    text("%PDF-1.4\n"),
    new Uint8Array([0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a]),
  ];
  let offset = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(offset);
    const head = text(`${i + 1} 0 obj\n`);
    const tail = text("\nendobj\n");
    chunks.push(head, body, tail);
    offset += head.length + body.length + tail.length;
  });
  const table = [
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`,
    ...offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`),
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
  ].join("");
  chunks.push(text(table));
  const file = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
  let at = 0;
  for (const chunk of chunks) {
    file.set(chunk, at);
    at += chunk.length;
  }
  return file;
}
