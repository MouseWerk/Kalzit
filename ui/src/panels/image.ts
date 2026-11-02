/**
 * A panel as a PNG image, drawn in the browser from what the panel shows: its title, its
 * visualization and its legend, in the theme on screen. It holds no more than the screen does,
 * so it needs no request; the panel menu offers it with the data export (`data:export`).
 *
 * The panel is copied with every element's computed style written onto the copy, so the image
 * keeps the look without the style sheets; canvases (charts, graph panels) become images of what
 * they drew. The copy goes into an SVG `foreignObject`, which the browser draws onto a canvas at
 * twice the screen's pixels or more. The bundled fonts are embedded, since an SVG image loads
 * nothing itself. What the page draws with pseudo-elements or outside the panel (menus, popovers)
 * is not part of the image.
 */

/** Left out of the image with everything inside: a panel's menu, handles and resize corner. */
export const NO_IMAGE = "data-no-image";

/**
 * Marks an element whose canvases draw with WebGL; it is sent `IMAGE_REDRAW` right before they
 * are read, so it draws again in that moment (a WebGL canvas keeps its picture only until the
 * browser has shown it).
 */
export const IMAGE_REDRAW_ATTRIBUTE = "data-image-redraw";
export const IMAGE_REDRAW = "kalzit:image-redraw";

const SVG_NS = "http://www.w3.org/2000/svg";
/** Elements whose content is never part of a picture. */
const SKIPPED = new Set(["SCRIPT", "NOSCRIPT", "TEMPLATE", "STYLE", "LINK", "DIALOG"]);

/** The computed style of `source` written onto `target`, without motion. */
function copyStyle(source: Element, target: Element) {
  const computed = getComputedStyle(source);
  let text = "";
  for (let i = 0; i < computed.length; i++) {
    const property = computed.item(i);
    // Custom properties are resolved in the values already; copying them would repeat every
    // design token on every element.
    if (property.startsWith("--")) continue;
    text += `${property}:${computed.getPropertyValue(property)};`;
  }
  target.setAttribute("style", `${text}animation:none;transition:none;`);
}

/** A canvas as an image of what it drew; `null` when the canvas cannot be read. */
function canvasImage(canvas: HTMLCanvasElement): HTMLImageElement | null {
  let src: string;
  try {
    src = canvas.toDataURL("image/png");
  } catch {
    return null;
  }
  const image = document.createElement("img");
  image.setAttribute("src", src);
  image.setAttribute("alt", "");
  copyStyle(canvas, image);
  const box = canvas.getBoundingClientRect();
  image.style.width = `${box.width}px`;
  image.style.height = `${box.height}px`;
  return image;
}

/** `node` and what it holds, with computed styles and canvases as images. */
export function copyForImage(node: Node): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
  if (!(node instanceof Element)) return null;
  if (node.hasAttribute(NO_IMAGE) || SKIPPED.has(node.tagName.toUpperCase())) return null;
  if (node instanceof HTMLCanvasElement) return canvasImage(node);
  const copy = node.cloneNode(false) as Element;
  copyStyle(node, copy);
  // What a field shows is its value, not its attribute.
  if (node instanceof HTMLInputElement) copy.setAttribute("value", node.value);
  if (node instanceof HTMLTextAreaElement) copy.textContent = node.value;
  if (node instanceof HTMLSelectElement) {
    const shown = node.selectedOptions[0]?.textContent ?? "";
    const text = document.createElement("span");
    copyStyle(node, text);
    text.textContent = shown;
    return text;
  }
  for (const child of Array.from(node.childNodes)) {
    const inner = copyForImage(child);
    if (inner !== null) copy.appendChild(inner);
  }
  return copy;
}

/** Font files already read, as data URLs, by their address. */
const fontData = new Map<string, Promise<string | null>>();

async function dataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { credentials: "same-origin" });
    if (!response.ok) return null;
    const blob = await response.blob();
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
      reader.onerror = () => resolve(null);
      reader.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

function fontRules(
  rules: CSSRuleList,
  base: string,
  out: { rule: CSSFontFaceRule; base: string }[],
) {
  for (const rule of Array.from(rules)) {
    if (rule instanceof CSSFontFaceRule) out.push({ rule, base });
    else if ("cssRules" in rule) fontRules((rule as CSSGroupingRule).cssRules, base, out);
  }
}

/**
 * The page's own `@font-face` rules with their files embedded, so the image uses Kalzit's fonts.
 * A file that cannot be read leaves its face out; the image then shows the fallback font.
 */
async function embeddedFonts(): Promise<string> {
  const faces: { rule: CSSFontFaceRule; base: string }[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    fontRules(rules, sheet.href ?? document.baseURI, faces);
  }
  const texts = await Promise.all(
    faces.map(async ({ rule, base }) => {
      let text = rule.cssText;
      const urls = [...text.matchAll(/url\(\s*(["']?)([^"')]+)\1\s*\)/g)];
      for (const match of urls) {
        const raw = match[2] ?? "";
        if (raw.startsWith("data:")) continue;
        const absolute = new URL(raw, base).href;
        if (!fontData.has(absolute)) fontData.set(absolute, dataUrl(absolute));
        const data = await fontData.get(absolute);
        if (data === null || data === undefined) return "";
        text = text.replace(match[0], `url("${data}")`);
      }
      return text;
    }),
  );
  return texts.filter((t) => t !== "").join("\n");
}

/** The colour behind the panel: its own, else the page's. */
function backdrop(element: HTMLElement): string {
  for (const candidate of [element, document.body, document.documentElement]) {
    const color = getComputedStyle(candidate).backgroundColor;
    if (color !== "" && color !== "transparent" && !/^rgba\(.*,\s*0\)$/.test(color)) return color;
  }
  return "#ffffff";
}

/** The copy of `element` as an SVG document of its size. */
export function panelSvg(
  element: HTMLElement,
  fonts: string,
): { svg: string; width: number; height: number } {
  const box = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(box.width));
  const height = Math.max(1, Math.ceil(box.height));
  // Canvases that draw with WebGL draw again now, so the copy below reads their picture.
  for (const target of Array.from(element.querySelectorAll(`[${IMAGE_REDRAW_ATTRIBUTE}]`))) {
    target.dispatchEvent(new Event(IMAGE_REDRAW));
  }
  const copy = copyForImage(element) as HTMLElement | null;
  if (copy === null) throw new Error("the panel cannot be copied");
  // Out of the grid and in place: the copy is the whole picture.
  copy.style.margin = "0";
  copy.style.transform = "none";
  copy.style.position = "relative";
  copy.style.inset = "auto";
  copy.style.width = `${width}px`;
  copy.style.height = `${height}px`;
  const html = new XMLSerializer().serializeToString(copy);
  const style = fonts === "" ? "" : `<style><![CDATA[${fonts.replaceAll("]]>", "")}]]></style>`;
  const svg =
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${style}<foreignObject x="0" y="0" width="100%" height="100%">${html}</foreignObject></svg>`;
  return { svg, width, height };
}

/** The image's pixels per screen pixel: at least two, so it stays sharp in documents. */
function scale(): number {
  return Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
}

/** `element` (a panel card) as a PNG image. */
export async function panelImage(element: HTMLElement): Promise<Blob> {
  await document.fonts?.ready;
  const fonts = await embeddedFonts();
  const { svg, width, height } = panelSvg(element, fonts);
  const image = new Image();
  image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await image.decode();
  const factor = scale();
  const canvas = document.createElement("canvas");
  canvas.width = width * factor;
  canvas.height = height * factor;
  const context = canvas.getContext("2d");
  if (context === null) throw new Error("the browser cannot draw the image");
  context.scale(factor, factor);
  context.fillStyle = backdrop(element);
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob === null ? reject(new Error("the image could not be made")) : resolve(blob)),
      "image/png",
    );
  });
}

/** A file name for the image of a panel titled `title`. */
export function imageFileName(title: string): string {
  const clean = title
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\w-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return `${clean === "" ? "kalzit-panel" : clean}.png`;
}
