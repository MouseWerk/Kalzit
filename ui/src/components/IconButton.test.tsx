import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANCHOR_GAP_PX, CONTROL_GAP_PX, VIEWPORT_MARGIN_PX } from "../lib/tooltipPlace";
import { IconButton, WithTooltip } from "./IconButton";

/**
 * The tooltip of an icon button: shown on hover and on keyboard focus, above the whole page
 * (at the end of the body, on the tooltip layer) instead of inside the bar or panel around the
 * button, which could clip it. jsdom lays nothing out, so the boxes are given.
 */

const TIP = { width: 120, height: 24 };
const VIEWPORT = { width: 1024, height: 768 };

function layOut(control: DOMRect) {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.matches(".floating-tooltip")) {
      return new DOMRect(0, 0, TIP.width, TIP.height);
    }
    return this.matches(".tip-anchor") ? control : new DOMRect(0, 0, 1024, 768);
  });
}

async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

const tip = () => document.querySelector<HTMLElement>(".tip");
const place = () => ({
  left: Number.parseFloat(tip()?.style.left ?? ""),
  top: Number.parseFloat(tip()?.style.top ?? ""),
});

/** A control that shows something it opened (a menu), toggled from outside its own button. */
function Opener() {
  const [open, setOpen] = useState(false);
  return (
    <WithTooltip label="More">
      <button type="button" aria-label="More" aria-expanded={open}>
        …
      </button>
      <button type="button" onClick={() => setOpen((value) => !value)}>
        Toggle from elsewhere
      </button>
    </WithTooltip>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("an icon button's tooltip", () => {
  const BUTTON = new DOMRect(500, 20, 32, 32);

  it("is in the page only while the pointer is over the button, at the end of the body", async () => {
    layOut(BUTTON);
    const { container } = render(
      <div className="bar">
        <IconButton icon="refresh" label="Refresh" shortcut="panel.edit" />
      </div>,
    );
    const bar = container.querySelector(".bar") as HTMLElement;
    // The bar clips what sticks out of it; the tooltip is not inside it.
    bar.style.overflowX = "hidden";
    bar.style.overflowY = "hidden";
    const button = screen.getByRole("button", { name: "Refresh" });
    expect(tip()).toBeNull();
    fireEvent.pointerEnter(button.parentElement as HTMLElement, { pointerType: "mouse" });
    await settle();
    expect(tip()?.textContent).toBe("RefreshE");
    expect(tip()?.parentElement).toBe(document.body);
    expect(bar.contains(tip())).toBe(false);
    expect(tip()?.classList.contains("floating-tooltip")).toBe(true);
    expect(tip()?.getAttribute("aria-hidden")).toBe("true");
    expect(tip()?.hasAttribute("data-placed")).toBe(true);
    // Under the button, its right edge on the button's.
    expect(place()).toEqual({
      left: BUTTON.right - TIP.width,
      top: BUTTON.bottom + CONTROL_GAP_PX,
    });
    fireEvent.pointerLeave(button.parentElement as HTMLElement);
    expect(tip()).toBeNull();
  });

  it("lines up with the button's start when asked", async () => {
    layOut(BUTTON);
    render(<IconButton icon="refresh" label="Refresh" tipAlign="start" />);
    const anchor = screen.getByRole("button", { name: "Refresh" }).parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    await settle();
    expect(place().left).toBe(BUTTON.left);
  });

  it("stays inside the window at its edges", async () => {
    // The last button of a bar, in the window's bottom right corner.
    const corner = new DOMRect(VIEWPORT.width - 40, VIEWPORT.height - 40, 32, 32);
    layOut(corner);
    render(<IconButton icon="refresh" label="Refresh" tipAlign="start" />);
    const anchor = screen.getByRole("button", { name: "Refresh" }).parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    await settle();
    expect(place()).toEqual({
      left: VIEWPORT.width - VIEWPORT_MARGIN_PX - TIP.width,
      top: corner.top - CONTROL_GAP_PX - TIP.height,
    });
  });

  it("opens before the button on a rail at the window's edge", async () => {
    const rail = new DOMRect(980, 200, 32, 32);
    layOut(rail);
    render(
      <aside data-tip-side="before">
        <IconButton icon="refresh" label="Refresh" />
      </aside>,
    );
    const anchor = screen.getByRole("button", { name: "Refresh" }).parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    await settle();
    expect(place()).toEqual({
      left: rail.left - ANCHOR_GAP_PX - TIP.width,
      top: rail.top + rail.height / 2 - TIP.height / 2,
    });
  });

  it("shows for keyboard focus, hides with Escape until the focus has left, not for a finger", async () => {
    layOut(BUTTON);
    const user = userEvent.setup();
    render(
      <>
        <IconButton icon="refresh" label="Refresh" />
        <button type="button">Next</button>
      </>,
    );
    const button = screen.getByRole("button", { name: "Refresh" });
    const anchor = button.parentElement as HTMLElement;
    // A finger has no hover.
    fireEvent.pointerEnter(anchor, { pointerType: "touch" });
    expect(tip()).toBeNull();
    await user.tab();
    expect(document.activeElement).toBe(button);
    expect(tip()?.textContent).toBe("Refresh");
    await user.keyboard("{Escape}");
    expect(tip()).toBeNull();
    await user.tab();
    expect(tip()).toBeNull();
    await user.tab({ shift: true });
    expect(tip()?.textContent).toBe("Refresh");
    await user.tab();
    expect(tip()).toBeNull();
  });

  it("goes away with a press and comes back when the pointer returns", async () => {
    layOut(BUTTON);
    const pressed = vi.fn();
    render(<IconButton icon="refresh" label="Refresh" onClick={pressed} />);
    const button = screen.getByRole("button", { name: "Refresh" });
    const anchor = button.parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    expect(tip()).not.toBeNull();
    // What the press opens (a dialog, a menu) is what the person looks at now.
    fireEvent.pointerDown(button);
    fireEvent.click(button);
    expect(pressed).toHaveBeenCalledTimes(1);
    expect(tip()).toBeNull();
    fireEvent.pointerLeave(anchor);
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    expect(tip()).not.toBeNull();
  });

  it("leaves with a focused button that scrolls out of view, and returns with it", async () => {
    const SCROLLER = new DOMRect(0, 100, 1024, 500);
    let control = new DOMRect(500, 200, 32, 32);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      if (this.matches(".floating-tooltip")) return new DOMRect(0, 0, TIP.width, TIP.height);
      if (this.matches(".tip-anchor")) return control;
      return this.matches(".scroller") ? SCROLLER : new DOMRect(0, 0, 1024, 768);
    });
    const user = userEvent.setup();
    const { container } = render(
      <div className="scroller">
        <IconButton icon="refresh" label="Refresh" />
      </div>,
    );
    const scroller = container.querySelector(".scroller") as HTMLElement;
    scroller.style.overflowX = "auto";
    scroller.style.overflowY = "auto";
    await user.tab();
    await settle();
    expect(tip()?.hasAttribute("data-placed")).toBe(true);
    expect(place().top).toBe(control.bottom + CONTROL_GAP_PX);

    const scrollTo = async (top: number) => {
      control = new DOMRect(500, top, 32, 32);
      fireEvent.scroll(scroller);
      await settle();
    };
    // Scrolled out at the top of its scroll box: the tooltip is not held at an edge.
    await scrollTo(40);
    expect(tip()?.hasAttribute("data-placed")).toBe(false);
    // Out of the window altogether.
    await scrollTo(-300);
    expect(tip()?.hasAttribute("data-placed")).toBe(false);
    // Back in view: back beside the button.
    await scrollTo(300);
    expect(tip()?.hasAttribute("data-placed")).toBe(true);
    expect(place().top).toBe(300 + 32 + CONTROL_GAP_PX);
  });

  it("is not shown while the control shows what it opened", async () => {
    layOut(BUTTON);
    render(<Opener />);
    const anchor = screen.getByRole("button", { name: "More" }).parentElement as HTMLElement;
    fireEvent.pointerEnter(anchor, { pointerType: "mouse" });
    expect(tip()?.textContent).toBe("More");
    // Opened by the keyboard shortcut while the pointer rests on the button.
    fireEvent.click(screen.getByRole("button", { name: "Toggle from elsewhere" }));
    await settle();
    expect(tip()).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Toggle from elsewhere" }));
    await settle();
    expect(tip()?.textContent).toBe("More");
  });
});
