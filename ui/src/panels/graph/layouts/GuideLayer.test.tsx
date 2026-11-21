import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LayoutGuide } from "../layoutProtocol";
import { GuideLayer, type Project } from "./GuideLayer";

/** Graph units to px: scaled by 2, y upwards on the page's way down. */
const project: Project = (x, y) => ({ x: 10 + 2 * x, y: 200 - 2 * y });

const GUIDES: LayoutGuide[] = [
  { kind: "ring", x: 0, y: 0, radius: 50 },
  { kind: "axis", axis: "x", x1: 0, y1: -10, x2: 100, y2: -10, min: 1000, max: 5000 },
  { kind: "axis", axis: "y", x1: -10, y1: 0, x2: -10, y2: 100, min: 2, max: 9 },
  { kind: "lane", lane: 0, x1: 0, x2: 100, y: 20 },
  { kind: "strip", x: 120, y: 90, width: 30, height: 60, count: 4, reason: "noValue" },
];

describe("guide layer", () => {
  it("draws rings, axes with their ends, lanes and the strip with count and reason", () => {
    const { container } = render(<GuideLayer guides={GUIDES} axes project={project} />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("aria-hidden")).toBe("true");
    const ring = container.querySelector("circle");
    expect(ring?.getAttribute("cx")).toBe("10");
    expect(ring?.getAttribute("cy")).toBe("200");
    expect(ring?.getAttribute("r")).toBe("100");
    expect(container.querySelectorAll("line")).toHaveLength(3);
    const text = [...container.querySelectorAll("text")].map((node) => node.textContent);
    expect(text).toContain("4 without a value");
    expect(text).toContain("1,000");
    expect(text).toContain("5,000");
    const strip = container.querySelector("rect");
    expect(strip?.getAttribute("x")).toBe("250");
    expect(strip?.getAttribute("width")).toBe("60");
    expect(strip?.getAttribute("height")).toBe("120");
  });

  it("draws times of a timeline axis as dates in UTC", () => {
    const time: LayoutGuide = {
      kind: "axis",
      axis: "time",
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 0,
      min: Date.UTC(2021, 0, 1),
      max: Date.UTC(2023, 5, 1),
    };
    const { container } = render(<GuideLayer guides={[time]} axes project={project} />);
    const text = [...container.querySelectorAll("text")].map((node) => node.textContent);
    expect(text.join(" ")).toMatch(/2021/);
    expect(text.join(" ")).toMatch(/2023/);
  });

  it("leaves the axes out when the panel hides them, but not the rings, lanes or strip", () => {
    const { container } = render(<GuideLayer guides={GUIDES} axes={false} project={project} />);
    expect(container.querySelectorAll("line")).toHaveLength(1);
    expect(container.querySelector("circle")).not.toBeNull();
    expect(container.querySelector("rect")).not.toBeNull();
    expect(container.textContent).not.toContain("1,000");
  });

  it("uses neutral classes only, and draws nothing without guides or a projection", () => {
    const { container, rerender } = render(<GuideLayer guides={GUIDES} axes project={project} />);
    for (const node of container.querySelectorAll("svg *")) {
      expect(node.getAttribute("style")).toBeNull();
      expect(node.getAttribute("stroke")).toBeNull();
      expect(node.getAttribute("fill")).toBeNull();
    }
    rerender(<GuideLayer guides={[]} axes project={project} />);
    expect(container.querySelector("svg")).toBeNull();
    rerender(<GuideLayer guides={GUIDES} axes project={null} />);
    expect(container.querySelector("svg")).toBeNull();
  });
});
