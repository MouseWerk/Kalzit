import { describe, expect, it } from "vitest";
import { revealInside } from "./revealInside";

function rect(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: 0,
    width: 0,
    x: 0,
    y: top,
  } as DOMRect;
}

function setup(itemTop: number, itemHeight = 32) {
  const container = document.createElement("nav");
  const element = document.createElement("a");
  container.append(element);
  container.getBoundingClientRect = () => rect(100, 400);
  element.getBoundingClientRect = () => rect(itemTop, itemHeight);
  container.scrollTop = 200;
  return { container, element };
}

describe("revealInside", () => {
  it("leaves an entry that is already visible alone", () => {
    const { container, element } = setup(200);
    revealInside(container, element);
    expect(container.scrollTop).toBe(200);
  });

  it("scrolls down until an entry below the fold ends at the bottom edge", () => {
    const { container, element } = setup(560);
    revealInside(container, element);
    expect(container.scrollTop).toBe(200 + 92);
  });

  it("scrolls up until an entry above the top edge starts there", () => {
    const { container, element } = setup(60);
    revealInside(container, element);
    expect(container.scrollTop).toBe(200 - 40);
  });

  it("shows the start of an entry taller than the container", () => {
    const { container, element } = setup(300, 600);
    revealInside(container, element);
    expect(container.scrollTop).toBe(200 + 200);
  });
});
