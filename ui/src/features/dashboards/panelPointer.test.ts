import { describe, expect, it } from "vitest";
import { DRAG_THRESHOLD, dragsFrom, isBodyDoubleClick, pastThreshold } from "./PanelCard";
import { hoveredPanelId } from "./panelShortcuts";

function card(): HTMLElement {
  const element = document.createElement("article");
  element.innerHTML = `
    <header class="panel-card__header">
      <h2 class="panel-card__title"><span class="title-text">Orders</span></h2>
      <span class="panel-card__note">Last 7 days</span>
      <div class="panel-card__actions">
        <button class="panel-card__handle"><svg class="icon"></svg></button>
        <span class="panel-card__size">6 × 4</span>
        <div class="panel-card__mini"><button class="edit"><svg class="icon"></svg>Edit</button></div>
        <button class="panel-menu__button">…</button>
        <button class="panel-card__about">i</button>
      </div>
    </header>
    <div class="panel-card__body">
      <div class="chart"><canvas></canvas></div>
      <table><thead><tr><th><button class="sort">Amount</button></th></tr></thead></table>
      <div role="application" class="graph"><div class="node"></div></div>
      <a href="/x" class="link">Wiki</a>
    </div>`;
  document.body.append(element);
  return element;
}

const at = (root: Element, selector: string) => root.querySelector(selector) as Element;

describe("dragging a panel by its header", () => {
  it("drags from the header's empty space, its title and the arrange handle", () => {
    const root = card();
    const header = at(root, "header");
    expect(dragsFrom(header, header)).toBe(true);
    expect(dragsFrom(at(root, ".title-text"), header)).toBe(true);
    expect(dragsFrom(at(root, ".panel-card__note"), header)).toBe(true);
    expect(dragsFrom(at(root, ".panel-card__handle svg"), header)).toBe(true);
    root.remove();
  });

  it("leaves Edit, the menu and the description to their own click", () => {
    const root = card();
    const header = at(root, "header");
    expect(dragsFrom(at(root, ".edit"), header)).toBe(false);
    expect(dragsFrom(at(root, ".edit svg"), header)).toBe(false);
    expect(dragsFrom(at(root, ".panel-menu__button"), header)).toBe(false);
    expect(dragsFrom(at(root, ".panel-card__about"), header)).toBe(false);
    expect(dragsFrom(null, header)).toBe(false);
    root.remove();
  });

  it("takes a press as a click until the pointer moves past the threshold", () => {
    const start = { x: 100, y: 100 };
    expect(pastThreshold(start, start)).toBe(false);
    expect(pastThreshold(start, { x: 102, y: 102 })).toBe(false);
    expect(pastThreshold(start, { x: 100 + DRAG_THRESHOLD, y: 100 })).toBe(true);
    expect(pastThreshold(start, { x: 97, y: 96 })).toBe(true);
  });
});

describe("opening a panel with a double click", () => {
  it("opens from its content and its title", () => {
    const root = card();
    expect(isBodyDoubleClick(at(root, "canvas"), root)).toBe(true);
    expect(isBodyDoubleClick(at(root, ".title-text"), root)).toBe(true);
    root.remove();
  });

  it("leaves controls and widgets with gestures of their own alone", () => {
    const root = card();
    expect(isBodyDoubleClick(at(root, ".sort"), root)).toBe(false);
    expect(isBodyDoubleClick(at(root, ".link"), root)).toBe(false);
    expect(isBodyDoubleClick(at(root, ".node"), root)).toBe(false);
    expect(isBodyDoubleClick(at(root, ".panel-menu__button"), root)).toBe(false);
    expect(isBodyDoubleClick(at(root, ".panel-card__size"), root)).toBe(false);
    root.remove();
  });
});

describe("the panel under the pointer", () => {
  it("is none without a hovered card", () => {
    const root = card();
    root.setAttribute("data-panel-id", "p1");
    expect(hoveredPanelId()).toBeNull();
    root.remove();
  });
});
