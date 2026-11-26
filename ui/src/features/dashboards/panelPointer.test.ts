import { describe, expect, it } from "vitest";
import {
  DRAG_THRESHOLD,
  dragsFrom,
  isBodyDoubleClick,
  pastThreshold,
  selectsOnClick,
} from "./PanelCard";
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
      <div class="ts__plot" tabindex="0" role="group"><div class="uplot"><canvas></canvas></div></div>
      <div class="readout" tabindex="0" role="group"><svg><rect class="bar"></rect></svg></div>
      <section class="vt" tabindex="0"><table><tbody><tr><td class="cell">12</td></tr></tbody></table></section>
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

describe("selecting a panel with a click", () => {
  it("selects from its content, its charts and tables included", () => {
    const root = card();
    expect(selectsOnClick(at(root, ".panel-card__body"), root)).toBe(true);
    expect(selectsOnClick(at(root, ".chart canvas"), root)).toBe(true);
    // A chart and a table take focus for the keyboard only; a click there is on the content.
    expect(selectsOnClick(at(root, ".ts__plot canvas"), root)).toBe(true);
    expect(selectsOnClick(at(root, ".readout .bar"), root)).toBe(true);
    expect(selectsOnClick(at(root, ".vt .cell"), root)).toBe(true);
    expect(selectsOnClick(at(root, ".title-text"), root)).toBe(true);
    root.remove();
  });

  it("leaves the card's controls to their own click", () => {
    const root = card();
    expect(selectsOnClick(at(root, ".sort"), root)).toBe(false);
    expect(selectsOnClick(at(root, ".link"), root)).toBe(false);
    expect(selectsOnClick(at(root, ".edit svg"), root)).toBe(false);
    expect(selectsOnClick(at(root, ".panel-menu__button"), root)).toBe(false);
    expect(selectsOnClick(null, root)).toBe(false);
    root.remove();
  });
});

describe("opening a panel with a double click", () => {
  it("opens from its content and its title", () => {
    const root = card();
    expect(isBodyDoubleClick(at(root, "canvas"), root)).toBe(true);
    expect(isBodyDoubleClick(at(root, ".ts__plot canvas"), root)).toBe(true);
    expect(isBodyDoubleClick(at(root, ".vt .cell"), root)).toBe(true);
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

  it("is the innermost hovered card", () => {
    // jsdom has no pointer to hover with: the page is asked through its :hover query.
    const outer = document.createElement("div");
    outer.setAttribute("data-panel-id", "p1");
    const inner = document.createElement("div");
    inner.setAttribute("data-panel-id", "p2");
    outer.append(inner);
    const asked: string[] = [];
    const page = {
      querySelectorAll: (selector: string) => {
        asked.push(selector);
        return [outer, inner];
      },
    } as unknown as ParentNode;
    expect(hoveredPanelId(page)).toBe("p2");
    expect(asked).toEqual(["[data-panel-id]:hover"]);
  });
});

describe("a double click that selected text", () => {
  it("selects the word and leaves the editor closed", () => {
    const root = card();
    const title = at(root, ".title-text");
    const range = document.createRange();
    range.selectNodeContents(title);
    window.getSelection()?.addRange(range);
    expect(isBodyDoubleClick(title, root)).toBe(false);
    window.getSelection()?.removeAllRanges();
    expect(isBodyDoubleClick(title, root)).toBe(true);
    root.remove();
  });
});
