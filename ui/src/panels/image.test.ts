import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyForImage,
  copyPanel,
  Defaults,
  embedResources,
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
    <iframe title="Plugin panel"></iframe>
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
  vi.unstubAllGlobals();
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
    const { copy, width, height } = copyPanel(element);
    expect(drawn).toEqual(["redraw", "read", "read"]);
    const svg = panelSvg(copy, width, height, "@font-face{font-family:x}");
    expect(svg).toContain("<foreignObject");
    expect(svg).toContain('xmlns="http://www.w3.org/1999/xhtml"');
    expect(svg).toContain("<![CDATA[@font-face{font-family:x}]]>");
    expect(svg).toContain(`width="${width}" height="${height}"`);
    // The frame of the defaults is gone again.
    expect(document.querySelectorAll("iframe")).toHaveLength(1);

    // The menu, the size badge and a plugin's frame are not part of the picture.
    expect(copy.textContent).toContain("Umsätze");
    expect(copy.textContent).not.toContain("Menu");
    expect(copy.textContent).not.toContain("2 × 3");
    expect(copy.querySelectorAll("canvas, iframe")).toHaveLength(0);
    const images = copy.querySelectorAll("img");
    expect(images).toHaveLength(2);
    expect(images[0]?.getAttribute("src")).toBe("data:image/png;base64,AAAA");
    expect(copy.querySelector("circle")).not.toBeNull();
    expect(copy.querySelector("input")?.getAttribute("value")).toBe("typed");
    // Computed styles are written onto the copy, resolved: no design tokens repeated.
    expect(copy.style.color).toBe("rgb(1, 2, 3)");
    expect(copy.getAttribute("style")).not.toContain("--accent");
  });

  it("writes only what differs from a plain element and from the parent", () => {
    const element = card();
    const defaults = new Defaults();
    const copy = copyForImage(element, defaults) as HTMLElement;
    defaults.dispose();
    const heading = copy.querySelector("h2") as HTMLElement;
    // The heading's color is inherited and equal to its parent's: it is not repeated.
    expect(heading.style.getPropertyValue("color")).toBe("");
    // A property the default has and the parent shares is left out.
    expect(heading.style.getPropertyValue("visibility")).toBe("");
    // The heading differs from a plain h2 nowhere else here, but a bold one would keep it.
    expect(copy.querySelector("header")?.getAttribute("style") ?? "").not.toContain("color");
  });

  it("keeps the scroll position of a scrolled part", () => {
    const element = card();
    const body = element.querySelector(".body") as HTMLElement;
    Object.defineProperty(body, "scrollTop", { value: 40 });
    const copy = copyForImage(element) as HTMLElement;
    const moved = copy.querySelector(".body > div") as HTMLElement;
    expect(moved.style.top).toBe("-40px");
    expect(moved.querySelector("circle")).not.toBeNull();
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

  it("embeds images and CSS images of its own origin, and leaves out the others", async () => {
    const asked: string[] = [];
    vi.stubGlobal("fetch", (url: string) => {
      asked.push(url);
      return Promise.resolve(new Response(new Blob(["x"], { type: "image/png" })));
    });
    const copy = document.createElement("div");
    copy.innerHTML = `<img src="/assets/logo.png" srcset="/a.png 2x"><img src="https://example.com/x.png"><span></span><i></i>`;
    const [span, mark] = [copy.querySelector("span"), copy.querySelector("i")] as HTMLElement[];
    span?.style.setProperty("background-image", 'url("/assets/icon.svg")');
    mark?.style.setProperty("mask-image", 'url("https://example.com/m.svg")');
    await embedResources(copy);
    const images = copy.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toMatch(/^data:[^,]*;base64,/);
    expect(images[0]?.hasAttribute("srcset")).toBe(false);
    expect(span?.style.getPropertyValue("background-image")).toMatch(/^url\("data:/);
    expect(mark?.style.getPropertyValue("mask-image")).toBe("");
    // Only Kalzit's own files are read.
    expect(asked.every((url) => url.startsWith(window.location.origin))).toBe(true);
  });

  it("names the file after the panel", () => {
    expect(imageFileName("Umsätze 2026 / Österreich")).toBe("Umsatze-2026-Osterreich.png");
    expect(imageFileName("")).toBe("kalzit-panel.png");
    expect(imageFileName("../../etc")).toBe("etc.png");
  });
});
