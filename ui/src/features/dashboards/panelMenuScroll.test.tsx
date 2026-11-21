import { act, fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { PanelMenu } from "./PanelMenu";

/** The menu closes on a scroll that moves its button, not on one that leaves it in place. */
describe("panel menu and scrolling", () => {
  function openMenu() {
    render(<PanelMenu title="Lagerbestand" items={[{ key: "a", label: "Edit", name: "Edit" }]} />);
    const button = screen.getByRole("button");
    let top = 100;
    vi.spyOn(button, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          top,
          left: 10,
          bottom: top + 20,
          right: 30,
          width: 20,
          height: 20,
          x: 10,
          y: top,
        }) as DOMRect,
    );
    fireEvent.click(button);
    return { move: (y: number) => (top = y) };
  }

  it("stays open when a scroll event leaves the button where it was", () => {
    openMenu();
    expect(screen.getByRole("menu")).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("menu")).not.toBeNull();
  });

  it("closes when the scroll moved the button", () => {
    const { move } = openMenu();
    move(60);
    act(() => {
      window.dispatchEvent(new Event("scroll"));
    });
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
