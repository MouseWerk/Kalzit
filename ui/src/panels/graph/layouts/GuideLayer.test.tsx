import { act, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LayoutGuide } from "../layoutProtocol";
import { createFrameSource, type FrameSource, GuideLayer, type Project } from "./GuideLayer";

/** Graph units to px: scaled by 2, y upwards on the page's way down. */
const project: Project = (x, y) => ({ x: 10 + 2 * x, y: 200 - 2 * y });

/** Renders the layer and delivers one frame, as the canvas does after drawing. */
async function drawn(guides: LayoutGuide[], axes: boolean, source = createFrameSource()) {
  const view = render(<GuideLayer guides={guides} axes={axes} frames={source} />);
  await act(async () => {
    source.emit(project);
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
  return { ...view, source };
}

/** The drawing around the layer: what must not re-render on a frame. */
const renders = { count: 0 };
function Wrapper({ frames, guides }: { frames: FrameSource; guides: LayoutGuide[] }) {
  renders.count++;
  return <GuideLayer guides={guides} axes frames={frames} />;
}

const GUIDES: LayoutGuide[] = [
  { kind: "ring", x: 0, y: 0, radius: 50 },
  { kind: "axis", axis: "x", x1: 0, y1: -10, x2: 100, y2: -10, min: 1000, max: 5000 },
  { kind: "axis", axis: "y", x1: -10, y1: 0, x2: -10, y2: 100, min: 2, max: 9 },
  { kind: "lane", lane: 0, x1: 0, x2: 100, y: 20 },
  { kind: "strip", x: 120, y: 90, width: 30, height: 60, count: 4, reason: "noValue" },
];

describe("guide layer", () => {
  it("draws rings, axes with their ends, lanes and the strip with count and reason", async () => {
    const { container } = await drawn(GUIDES, true);
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

  it("draws times of a timeline axis as dates in UTC", async () => {
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
    const { container } = await drawn([time], true);
    const text = [...container.querySelectorAll("text")].map((node) => node.textContent);
    expect(text.join(" ")).toMatch(/2021/);
    expect(text.join(" ")).toMatch(/2023/);
  });

  it("leaves the axes out when the panel hides them, but not the rings, lanes or strip", async () => {
    const { container } = await drawn(GUIDES, false);
    expect(container.querySelectorAll("line")).toHaveLength(1);
    expect(container.querySelector("circle")).not.toBeNull();
    expect(container.querySelector("rect")).not.toBeNull();
    expect(container.textContent).not.toContain("1,000");
  });

  it("uses neutral classes only, and draws nothing without guides or before a frame", async () => {
    const { container, rerender, source } = await drawn(GUIDES, true);
    for (const node of container.querySelectorAll("svg *")) {
      expect(node.getAttribute("style")).toBeNull();
      expect(node.getAttribute("stroke")).toBeNull();
      expect(node.getAttribute("fill")).toBeNull();
    }
    rerender(<GuideLayer guides={[]} axes frames={source} />);
    expect(container.querySelector("svg")).toBeNull();
    const fresh = render(<GuideLayer guides={GUIDES} axes frames={createFrameSource()} />);
    expect(fresh.container.querySelector("svg")).toBeNull();
  });

  it("does not subscribe to frames, nor re-render its parent, when there are no guides", async () => {
    const source = createFrameSource();
    const subscribe = vi.spyOn(source, "subscribe");
    render(<Wrapper frames={source} guides={[]} />);
    const before = renders.count;
    await act(async () => {
      for (let i = 0; i < 5; i++) source.emit(project);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(subscribe).not.toHaveBeenCalled();
    expect(renders.count).toBe(before);
  });

  it("follows the frames when there are guides, without re-rendering its parent", async () => {
    const source = createFrameSource();
    const { container } = render(<Wrapper frames={source} guides={GUIDES} />);
    const before = renders.count;
    const panned: Project = (x, y) => ({ x: 50 + 2 * x, y: 200 - 2 * y });
    await act(async () => {
      source.emit(project);
      source.emit(panned);
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // Two frames in one animation frame: only the newest is drawn.
    expect(container.querySelector("circle")?.getAttribute("cx")).toBe("50");
    expect(renders.count).toBe(before);
  });
});
