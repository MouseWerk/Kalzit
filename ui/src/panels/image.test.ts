import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyForImage,
  IMAGE_REDRAW,
  IMAGE_REDRAW_ATTRIBUTE,
  imageFileName,
  NO_IMAGE,
  panelSvg,
} from "./image";

function card(): HTMLElement {
  const article = document.createElement("article");
  article.innerHTML = `
    <header><h2>Umsätze</h2><div ${NO_IMAGE}=""><button>Menu</button></div></header>
    <div class="body" ${IMAGE_REDRAW_ATTRIBUTE}="">
      <canvas width="20" height="10"></canvas>
      <canvas width="20" height="10"></canvas>
      <svg><circle r="3"></circle></svg>
    </div>
    <input value="typed">
    <span ${NO_IMAGE}="">2 × 3</span>`;
  article.style.setProperty("--accent", "red");
  article.style.color = "rgb(1, 2, 3)";
  document.body.append(article);
  return article;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("panel image", () => {
  it("copies what the panel shows, with canvases as pictures of what they drew", () => {
    const element = card();
    const drawn: string[] = [];
    // A WebGL canvas keeps its picture only until the browser showed it: it draws again first.
    element.querySelector(`[${IMAGE_REDRAW_ATTRIBUTE}]`)?.addEventListener(IMAGE_REDRAW, () => {
      drawn.push("redraw");
    });
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      drawn.push("read");
      return "data:image/png;base64,AAAA";
    });
    const { svg, width, height } = panelSvg(element, "@font-face{font-family:x}");
    expect(drawn).toEqual(["redraw", "read", "read"]);
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain("<![CDATA[@font-face{font-family:x}]]>");
    expect(svg).toContain(`width="${width}" height="${height}"`);

    const copy = copyForImage(element) as HTMLElement;
    // The menu and the size badge are not part of the picture.
    expect(copy.textContent).toContain("Umsätze");
    expect(copy.textContent).not.toContain("Menu");
    expect(copy.textContent).not.toContain("2 × 3");
    expect(copy.querySelectorAll("canvas")).toHaveLength(0);
    const images = copy.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(copy.querySelector("circle")).not.toBeNull();
    expect(copy.querySelector("input")?.getAttribute("value")).toBe("typed");
    // Computed styles are written onto the copy, resolved: no design tokens repeated.
    const style = copy.getAttribute("style") ?? "";
    expect(style).toContain("color:rgb(1, 2, 3)");
    expect(style).not.toContain("--accent");
  });

  it("leaves a canvas out that cannot be read", () => {
    const element = card();
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockImplementation(() => {
      throw new DOMException("tainted", "SecurityError");
    });
    const copy = copyForImage(element) as HTMLElement;
    expect(copy.querySelectorAll("img, canvas")).toHaveLength(0);
    expect(copy.textContent).toContain("Umsätze");
  });

  it("names the file after the panel", () => {
    expect(imageFileName("Umsätze 2026 / Österreich")).toBe("Umsatze-2026-Osterreich.png");
    expect(imageFileName("")).toBe("kalzit-panel.png");
    expect(imageFileName("../../etc")).toBe("etc.png");
  });
});
