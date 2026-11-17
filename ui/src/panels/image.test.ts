import { afterEach, describe, expect, it, vi } from "vitest";
import {
  copyForImage,
  copyPanel,
  Defaults,
  embedResources,
  IMAGE_REDRAW,
  IMAGE_REDRAW_ATTRIBUTE,
  imageFileName,
  imageFill,
  NO_IMAGE,
  panelImage,
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

/**
 * jsdom draws nothing, so the canvas is a recorder: what `panelImage` fills before it draws the
 * copy, and the copy it draws (the SVG, taken from the image's address). The pixels themselves
 * are checked in a browser (e2e/panel-image.spec.ts).
 */
function recordCanvas(): { fills: { style: unknown; rect: number[] }[]; svg: () => string } {
  const fills: { style: unknown; rect: number[] }[] = [];
  let svg = "";
  const context = {
    fillStyle: "" as unknown,
    scale: () => undefined,
    fillRect(...rect: number[]) {
      fills.push({ style: this.fillStyle, rect });
    },
    drawImage(image: HTMLImageElement) {
      svg = decodeURIComponent(image.src.slice(image.src.indexOf(",") + 1));
    },
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(context as never);
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((done) =>
    done(new Blob(["png"], { type: "image/png" })),
  );
  // jsdom's images have no `decode`; it is taken away again after each test.
  Object.defineProperty(HTMLImageElement.prototype, "decode", {
    configurable: true,
    value: () => Promise.resolve(),
  });
  return { fills, svg: () => svg };
}

/** A panel card as the dashboard styles it: a frame, rounded corners, a shadow. */
function framedCard(background: string): HTMLElement {
  const element = card();
  element.style.border = "1px solid rgb(200, 200, 200)";
  element.style.borderRadius = "12px";
  element.style.boxShadow = "0 1px 2px rgb(0, 0, 0)";
  element.style.outline = "2px solid rgb(9, 9, 9)";
  element.style.background = background;
  vi.spyOn(element, "getBoundingClientRect").mockReturnValue(new DOMRect(0, 0, 300, 200));
  return element;
}

afterEach(() => {
  document.body.style.background = "";
  Reflect.deleteProperty(HTMLImageElement.prototype, "decode");
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
    vi.stubGlobal("fetch", (url: string, init?: RequestInit) => {
      asked.push(url);
      expect(init?.redirect).toBe("error");
      const response = new Response(new Blob(["x"], { type: "image/png" }));
      Object.defineProperty(response, "url", { value: new URL(url, window.location.href).href });
      return Promise.resolve(response);
    });
    const copy = document.createElement("div");
    copy.innerHTML = `<img src="/assets/logo.png" srcset="/a.png 2x"><img src="https://example.com/x.png"><img src=""><span></span><i></i>`;
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

  it("takes no file that answers from another origin", async () => {
    vi.stubGlobal("fetch", () => {
      const response = new Response(new Blob(["x"], { type: "image/png" }));
      Object.defineProperty(response, "url", { value: "https://example.com/elsewhere.png" });
      return Promise.resolve(response);
    });
    const copy = document.createElement("div");
    copy.innerHTML = `<img src="/assets/moved.png">`;
    await embedResources(copy);
    expect(copy.querySelectorAll("img")).toHaveLength(0);
  });

  it("copies the card without its frame line, rounded corners, shadow and focus ring", () => {
    const { copy } = copyPanel(framedCard("rgb(250, 250, 250)"));
    expect(copy.style.borderRadius).toBe("0px");
    for (const side of ["top", "right", "bottom", "left"]) {
      expect(copy.style.getPropertyValue(`border-${side}-width`), side).toBe("0px");
      expect(copy.style.getPropertyValue(`border-${side}-style`), side).toBe("none");
    }
    expect(copy.style.boxShadow).toBe("none");
    expect(copy.style.outline).toBe("none");
    // The panel's own colour stays on the copy.
    expect(copy.style.backgroundColor).toBe("rgb(250, 250, 250)");
  });

  it("takes the frame away under its logical names too, which would win over the physical", () => {
    // A browser's computed style names each border twice (border-left and border-inline-start);
    // in the copy's style the later name decides, so a frame left under either one would show
    // in the picture. The pixels are checked in a browser (e2e/panel-image.spec.ts).
    const element = framedCard("rgb(250, 250, 250)");
    for (const side of ["block-start", "block-end", "inline-start", "inline-end"]) {
      element.style.setProperty(`border-${side}-width`, "1px");
      element.style.setProperty(`border-${side}-style`, "solid");
      element.style.setProperty(`border-${side}-color`, "rgb(200, 200, 200)");
    }
    element.style.setProperty("border-start-start-radius", "12px");
    const { copy } = copyPanel(element);
    for (const side of ["block-start", "block-end", "inline-start", "inline-end"]) {
      expect(copy.style.getPropertyValue(`border-${side}-width`), side).toMatch(/^0(px)?$/);
      expect(copy.style.getPropertyValue(`border-${side}-style`), side).toBe("none");
    }
    expect(copy.style.getPropertyValue("border-start-start-radius")).toMatch(/^0(px)?$/);
    // No width or style of a line is left under any name.
    const declared = copy.getAttribute("style") ?? "";
    expect(declared).not.toMatch(/border[\w-]*-width: 1px/);
    expect(declared).not.toMatch(/border[\w-]*-style: solid/);
    expect(declared).not.toContain("12px");
  });

  it("fills an opaque panel's picture with the panel's colour, to every corner", async () => {
    const canvas = recordCanvas();
    const blob = await panelImage(framedCard("rgb(250, 250, 250)"));
    expect(blob.type).toBe("image/png");
    // One fill, over the whole picture, in the panel's colour.
    expect(canvas.fills).toEqual([{ style: "rgb(250, 250, 250)", rect: [0, 0, 300, 200] }]);
    // The copy drawn on top is square and has no frame, so the corners keep that colour.
    const root = canvas.svg().match(/<article[^>]*>/)?.[0] ?? "";
    expect(root).toContain("border-radius: 0px");
    expect(root).toContain("box-shadow: none");
    expect(root).not.toContain("12px");
    expect(root).not.toContain("rgb(200, 200, 200)");
    expect(root).not.toContain("rgb(9, 9, 9)");
  });

  it("fills nothing for a transparent panel: the picture stays transparent", async () => {
    // The page's colour is never painted in.
    document.body.style.background = "rgb(20, 20, 20)";
    const canvas = recordCanvas();
    await panelImage(framedCard("transparent"));
    expect(canvas.fills).toEqual([]);
    const root = canvas.svg().match(/<article[^>]*>/)?.[0] ?? "";
    expect(root).not.toBe("");
    expect(root).not.toContain("rgb(20, 20, 20)");
    expect(root).toContain("border-radius: 0px");
    expect(root).not.toContain("rgb(200, 200, 200)");
  });

  it("takes a fill only from an opaque colour of the panel itself", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const fill = (background: string) => {
      element.style.background = background;
      return imageFill(element);
    };
    expect(fill("rgb(1, 2, 3)")).toBe("rgb(1, 2, 3)");
    expect(fill("transparent")).toBeNull();
    expect(fill("rgba(1, 2, 3, 0)")).toBeNull();
    expect(fill("rgba(1, 2, 3, 0.5)")).toBeNull();
  });

  it("names the file after the panel", () => {
    expect(imageFileName("Umsätze 2026 / Österreich")).toBe("Umsatze-2026-Osterreich.png");
    expect(imageFileName("")).toBe("kalzit-panel.png");
    expect(imageFileName("../../etc")).toBe("etc.png");
  });
});
