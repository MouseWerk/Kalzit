import { labelWidth } from "../../measure";
import { isWinAnsi, type TextImage } from "./pdf";
import type { MeasureAt, Op, Picture } from "./picture";

/**
 * What needs the browser's canvas: measuring text, the picture as a PNG (drawn straight onto a
 * canvas from the same shapes, in the page's fonts), and single texts as images for the PDF.
 */

/** A browser canvas is at most this wide or high, and holds at most this many pixels. */
const MAX_SIDE = 16_384;
const MAX_PIXELS = 2 ** 28;

/** The fonts measured for Helvetica: the font itself or one of the fonts made to its widths. */
const HELVETICA = 'Helvetica, Arial, "Liberation Sans", "Nimbus Sans", sans-serif';

function cssFont(size: number, bold: boolean, family: string, boldWeight: string): string {
  return `${bold ? boldWeight : "400"} ${size}px ${family}`;
}

/** Measures text in the picture's own font: for SVG and PNG, which draw it in that font. */
export function measureIn(family: string, boldWeight: string): MeasureAt {
  return (text, size, bold) => labelWidth(text, cssFont(size, bold, family, boldWeight));
}

/**
 * Measures text as the PDF writes it: in Helvetica where it can write the text, in the picture's
 * own font where the text goes in as an image.
 */
export function measureForPdf(family: string, boldWeight: string): MeasureAt {
  const own = measureIn(family, boldWeight);
  return (text, size, bold) =>
    isWinAnsi(text)
      ? labelWidth(text, cssFont(size, bold, HELVETICA, "700"))
      : own(text, size, bold);
}

function draw(context: CanvasRenderingContext2D, op: Op, picture: Picture) {
  switch (op.kind) {
    case "rect":
      context.fillStyle = op.fill;
      context.fillRect(op.x, op.y, op.width, op.height);
      break;
    case "circle":
      context.fillStyle = op.fill;
      context.beginPath();
      context.arc(op.cx, op.cy, op.r, 0, 2 * Math.PI);
      context.fill();
      break;
    case "ring":
      context.strokeStyle = op.stroke;
      context.lineWidth = op.width;
      context.beginPath();
      context.arc(op.cx, op.cy, op.r, 0, 2 * Math.PI);
      context.stroke();
      break;
    case "polygon":
      context.fillStyle = op.fill;
      context.beginPath();
      for (let i = 0; i + 1 < op.points.length; i += 2) {
        if (i === 0) context.moveTo(op.points[i] ?? 0, op.points[i + 1] ?? 0);
        else context.lineTo(op.points[i] ?? 0, op.points[i + 1] ?? 0);
      }
      context.closePath();
      context.fill();
      break;
    case "line":
      context.strokeStyle = op.stroke;
      context.lineWidth = op.width;
      context.beginPath();
      context.moveTo(op.x1, op.y1);
      context.lineTo(op.x2, op.y2);
      context.stroke();
      break;
    case "text":
      context.fillStyle = op.fill;
      context.font = cssFont(op.size, op.bold, picture.font, picture.boldWeight);
      context.textAlign = op.anchor === "middle" ? "center" : "left";
      context.textBaseline = "alphabetic";
      context.fillText(op.text, op.x, op.y);
      break;
  }
}

/** The pixels per px a canvas of this picture can have, at most `wanted`. */
export function pngScale(width: number, height: number, wanted: number): number {
  return Math.min(
    wanted,
    MAX_SIDE / width,
    MAX_SIDE / height,
    Math.sqrt(MAX_PIXELS / (width * height)),
  );
}

/** The picture as a PNG at twice its size in pixels (less where a canvas cannot be that large). */
export async function picturePng(picture: Picture, wanted = 2): Promise<Blob> {
  await document.fonts?.ready;
  const scale = pngScale(picture.width, picture.height, wanted);
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(picture.width * scale));
  canvas.height = Math.max(1, Math.round(picture.height * scale));
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the browser cannot draw the image");
  context.scale(scale, scale);
  if (picture.background !== null) {
    context.fillStyle = picture.background;
    context.fillRect(0, 0, picture.width, picture.height);
  }
  for (const layer of picture.layers) {
    context.save();
    if (layer.clip !== null) {
      context.beginPath();
      context.rect(layer.clip.x, layer.clip.y, layer.clip.width, layer.clip.height);
      context.clip();
    }
    for (const op of layer.ops) draw(context, op, picture);
    context.restore();
  }
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("the image could not be made")) : resolve(blob)),
      "image/png",
    );
  });
}

/** Pixels per px of a text drawn as an image, so it stays sharp when a PDF is enlarged. */
const TEXT_SCALE = 3;

/**
 * One text as an image in the picture's font, for the PDF: its colors and its opacity apart, as
 * a PDF holds them. Null where the browser gives no canvas.
 */
export function textImage(
  op: Extract<Op, { kind: "text" }>,
  family: string,
  boldWeight: string,
): TextImage | null {
  const ascent = Math.ceil(op.size);
  const height = Math.ceil(op.size * 1.4);
  const width = Math.max(1, Math.ceil(op.width) + 2);
  const canvas = document.createElement("canvas");
  canvas.width = width * TEXT_SCALE;
  canvas.height = height * TEXT_SCALE;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (context === null) return null;
  context.scale(TEXT_SCALE, TEXT_SCALE);
  context.fillStyle = op.fill;
  context.font = cssFont(op.size, op.bold, family, boldWeight);
  context.textBaseline = "alphabetic";
  context.fillText(op.text, 0, ascent);
  let data: Uint8ClampedArray;
  try {
    data = context.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch {
    return null;
  }
  const pixels = canvas.width * canvas.height;
  const rgb = new Uint8Array(pixels * 3);
  const alpha = new Uint8Array(pixels);
  for (let i = 0; i < pixels; i++) {
    rgb[i * 3] = data[i * 4] ?? 0;
    rgb[i * 3 + 1] = data[i * 4 + 1] ?? 0;
    rgb[i * 3 + 2] = data[i * 4 + 2] ?? 0;
    alpha[i] = data[i * 4 + 3] ?? 0;
  }
  return {
    pixelWidth: canvas.width,
    pixelHeight: canvas.height,
    rgb,
    alpha,
    width,
    height,
    ascent,
  };
}
