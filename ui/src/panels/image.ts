/**
 * A panel as a PNG image, drawn in the browser from what the panel shows: its title, its
 * visualization and its legend, in the theme on screen. It holds no more than the screen does,
 * so it needs no request; the panel menu offers it with the data export (`data:export`).
 *
 * The panel is copied with each element's computed style written onto the copy (only what differs
 * from a plain element of its kind), so the image keeps the look without the style sheets;
 * canvases (charts, graph panels) become images of what they drew, and scrolled parts keep their
 * scroll position. The copy goes into an SVG `foreignObject`, which the browser draws onto a
 * canvas at twice the screen's pixels or more. An SVG image loads nothing itself, so the bundled
 * fonts, images and CSS images (backgrounds, masks) of Kalzit's own origin are embedded; others
 * are left out. What the page draws with pseudo-elements or outside the panel (menus, popovers)
 * is not part of the image, nor are panel plugins, which draw in a frame of their own.
 */

import { fetchOwnFile } from "../api/client";

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

/**
 * Elements whose content is never part of a picture. A panel plugin draws in a frame of its own
 * origin, which the page cannot read: frames and embedded objects are left out.
 */
const SKIPPED = new Set([
  "SCRIPT",
  "NOSCRIPT",
  "TEMPLATE",
  "STYLE",
  "LINK",
  "DIALOG",
  "IFRAME",
  "OBJECT",
  "EMBED",
]);

/** The CSS properties that may hold an image. */
const IMAGE_PROPERTIES = [
  "background-image",
  "mask-image",
  "-webkit-mask-image",
  "list-style-image",
  "border-image-source",
];

const URL_PATTERN = /url\(\s*(["']?)([^"')]+)\1\s*\)/g;

/**
 * The computed styles of plain elements, per kind, from a frame without style sheets: a copied
 * element carries only what differs from them.
 */
export class Defaults {
  private frame: HTMLIFrameElement | null = null;
  private readonly styles = new Map<string, Map<string, string> | null>();

  of(element: Element): Map<string, string> | null {
    const kind = `${element.namespaceURI} ${element.localName}`;
    const known = this.styles.get(kind);
    if (known !== undefined) return known;
    if (this.frame === null) {
      this.frame = document.createElement("iframe");
      this.frame.setAttribute("aria-hidden", "true");
      this.frame.tabIndex = -1;
      this.frame.hidden = true;
      document.body.append(this.frame);
    }
    const doc = this.frame.contentDocument;
    const view = this.frame.contentWindow;
    if (doc === null || view === null || doc.body === null) {
      this.styles.set(kind, null);
      return null;
    }
    const plain = doc.createElementNS(element.namespaceURI, element.localName);
    doc.body.append(plain);
    const computed = view.getComputedStyle(plain);
    const values = new Map<string, string>();
    for (let i = 0; i < computed.length; i++) {
      const property = computed.item(i);
      values.set(property, computed.getPropertyValue(property));
    }
    plain.remove();
    this.styles.set(kind, values);
    return values;
  }

  dispose() {
    this.frame?.remove();
    this.frame = null;
  }
}

/**
 * The computed style of `source` written onto `target`, without motion. A property is left out
 * when it has the plain element's value and its parent's too, so neither the default nor what
 * the copy inherits changes it.
 */
function copyStyle(source: Element, target: Element, defaults: Defaults | null) {
  const computed = getComputedStyle(source);
  const parent = source.parentElement === null ? null : getComputedStyle(source.parentElement);
  const plain = parent === null ? null : (defaults?.of(source) ?? null);
  // Through the CSSOM, never a style attribute: the content security policy (style-src 'self')
  // refuses inline style text, but not styles set from script.
  const style = (target as HTMLElement | SVGElement).style;
  for (let i = 0; i < computed.length; i++) {
    const property = computed.item(i);
    // Custom properties are resolved in the values already; copying them would repeat every
    // design token on every element.
    if (property.startsWith("--")) continue;
    const value = computed.getPropertyValue(property);
    if (plain?.get(property) === value && parent?.getPropertyValue(property) === value) continue;
    style.setProperty(property, value);
  }
  style.setProperty("animation", "none");
  style.setProperty("transition", "none");
}

/** An empty element like `source`, with its attributes but not its style attribute. */
function shallowCopy(source: Element): Element {
  const copy = document.createElementNS(source.namespaceURI, source.localName);
  for (const attribute of Array.from(source.attributes)) {
    if (attribute.name === "style") continue;
    copy.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
  }
  return copy;
}

/** A canvas as an image of what it drew; `null` when the canvas cannot be read. */
function canvasImage(
  canvas: HTMLCanvasElement,
  defaults: Defaults | null,
): HTMLImageElement | null {
  let src: string;
  try {
    src = canvas.toDataURL("image/png");
  } catch {
    return null;
  }
  const image = document.createElement("img");
  image.setAttribute("src", src);
  image.setAttribute("alt", "");
  copyStyle(canvas, image, defaults);
  const box = canvas.getBoundingClientRect();
  image.style.width = `${box.width}px`;
  image.style.height = `${box.height}px`;
  return image;
}

/** `node` and what it holds, with computed styles and canvases as images. */
export function copyForImage(node: Node, defaults: Defaults | null = null): Node | null {
  if (node.nodeType === Node.TEXT_NODE) return node.cloneNode();
  if (!(node instanceof Element)) return null;
  if (node.hasAttribute(NO_IMAGE) || SKIPPED.has(node.tagName.toUpperCase())) return null;
  if (node instanceof HTMLCanvasElement) return canvasImage(node, defaults);
  const copy = shallowCopy(node);
  copyStyle(node, copy, defaults);
  // What a field shows is its value, not its attribute.
  if (node instanceof HTMLInputElement) copy.setAttribute("value", node.value);
  if (node instanceof HTMLTextAreaElement) copy.textContent = node.value;
  if (node instanceof HTMLSelectElement) {
    const shown = node.selectedOptions[0]?.textContent ?? "";
    const text = document.createElement("span");
    copyStyle(node, text, defaults);
    text.textContent = shown;
    return text;
  }
  const children = Array.from(node.childNodes)
    .map((child) => copyForImage(child, defaults))
    .filter((inner): inner is Node => inner !== null);
  placeScrolled(node, copy, children);
  return copy;
}

/**
 * Puts the copied `children` into `copy`, moved by `source`'s scroll position, so a scrolled
 * table shows the rows that are in view. Flex and grid items move one by one (a wrapper would
 * change their layout); anything else moves inside one wrapper.
 */
function placeScrolled(source: Element, copy: Element, children: Node[]) {
  const { scrollTop: top, scrollLeft: left } = source;
  if (top === 0 && left === 0) {
    copy.append(...children);
    return;
  }
  if (/flex|grid/.test(getComputedStyle(source).display)) {
    for (const child of children) {
      if (child instanceof HTMLElement || child instanceof SVGElement) {
        child.style.setProperty("translate", `${-left}px ${-top}px`);
      }
    }
    copy.append(...children);
    return;
  }
  const wrapper = document.createElement("div");
  wrapper.style.setProperty("position", "relative");
  wrapper.style.setProperty("top", `${-top}px`);
  wrapper.style.setProperty("left", `${-left}px`);
  wrapper.append(...children);
  copy.append(wrapper);
}

/** Files already read (fonts, images), as data URLs, by their address. */
const fileData = new Map<string, Promise<string | null>>();

/** A file of Kalzit's own origin as a data URL; `null` for another origin or a failed read. */
function cachedData(url: string, base = document.baseURI): Promise<string | null> {
  const absolute = new URL(url, base).href;
  let data = fileData.get(absolute);
  if (data === undefined) {
    data = dataUrl(absolute);
    fileData.set(absolute, data);
  }
  return data;
}

async function dataUrl(url: string): Promise<string | null> {
  const blob = await fetchOwnFile(url);
  if (blob === null) return null;
  return await new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === "string" ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/** `value` with each `url()` as a data URL; `null` when one of them cannot be read. */
async function embedUrls(value: string, base = document.baseURI): Promise<string | null> {
  let text = value;
  for (const match of [...value.matchAll(URL_PATTERN)]) {
    const raw = match[2] ?? "";
    if (raw.startsWith("data:")) continue;
    const data = await cachedData(raw, base);
    if (data === null) return null;
    text = text.replace(match[0], `url("${data}")`);
  }
  return text;
}

/**
 * Embeds what the copy would load: images and CSS images of Kalzit's own origin become data
 * URLs; the others are left out.
 */
export async function embedResources(copy: Element): Promise<void> {
  const work: Promise<void>[] = [];
  for (const image of Array.from(copy.querySelectorAll("img"))) {
    const src = image.getAttribute("src") ?? "";
    image.removeAttribute("srcset");
    if (src.startsWith("data:")) continue;
    work.push(
      cachedData(src).then((data) => {
        if (data === null) image.remove();
        else image.setAttribute("src", data);
      }),
    );
  }
  for (const element of [copy, ...Array.from(copy.querySelectorAll("*"))]) {
    const style = (element as HTMLElement | SVGElement).style;
    if (style === undefined) continue;
    for (const property of IMAGE_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (!value.includes("url(")) continue;
      work.push(
        embedUrls(value).then((embedded) => {
          if (embedded === null) style.removeProperty(property);
          else style.setProperty(property, embedded);
        }),
      );
    }
  }
  await Promise.all(work);
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
    faces.map(async ({ rule, base }) => (await embedUrls(rule.cssText, base)) ?? ""),
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

/** The copy of `element` and its size, made in one go (see `IMAGE_REDRAW`). */
export function copyPanel(element: HTMLElement): {
  copy: HTMLElement;
  width: number;
  height: number;
} {
  const box = element.getBoundingClientRect();
  const width = Math.max(1, Math.ceil(box.width));
  const height = Math.max(1, Math.ceil(box.height));
  // Canvases that draw with WebGL draw again now, so the copy below reads their picture.
  for (const target of Array.from(element.querySelectorAll(`[${IMAGE_REDRAW_ATTRIBUTE}]`))) {
    target.dispatchEvent(new Event(IMAGE_REDRAW));
  }
  const defaults = new Defaults();
  let copy: HTMLElement | null;
  try {
    copy = copyForImage(element, defaults) as HTMLElement | null;
  } finally {
    defaults.dispose();
  }
  if (copy === null) throw new Error("the panel cannot be copied");
  // Out of the grid and in place: the copy is the whole picture.
  copy.style.margin = "0";
  copy.style.transform = "none";
  copy.style.position = "relative";
  copy.style.inset = "auto";
  copy.style.width = `${width}px`;
  copy.style.height = `${height}px`;
  return { copy, width, height };
}

/** The copy as an SVG document of its size, with the fonts' rules. */
export function panelSvg(copy: HTMLElement, width: number, height: number, fonts: string): string {
  const html = new XMLSerializer().serializeToString(copy);
  const style = fonts === "" ? "" : `<style><![CDATA[${fonts.replaceAll("]]>", "")}]]></style>`;
  return (
    `<svg xmlns="${SVG_NS}" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">` +
    `${style}<foreignObject x="0" y="0" width="100%" height="100%">${html}</foreignObject></svg>`
  );
}

/** The image's pixels per screen pixel: at least two, so it stays sharp in documents. */
function scale(): number {
  return Math.min(3, Math.max(2, Math.ceil(window.devicePixelRatio || 1)));
}

/** `element` (a panel card) as a PNG image. */
export async function panelImage(element: HTMLElement): Promise<Blob> {
  await document.fonts?.ready;
  const fonts = await embeddedFonts();
  const { copy, width, height } = copyPanel(element);
  await embedResources(copy);
  const svg = panelSvg(copy, width, height, fonts);
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
