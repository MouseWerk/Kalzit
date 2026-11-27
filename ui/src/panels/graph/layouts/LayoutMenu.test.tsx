import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { LAYOUT_MODES, type LayoutMode, parseGraphOptions } from "../options";
import { layoutSettings } from "./inputs";
import { LayoutMenu, type LayoutMenuProps } from "./LayoutMenu";

function props(patch: Partial<LayoutMenuProps> = {}): LayoutMenuProps {
  const available = { reason: null, placed: 4, total: 4 } as const;
  const availability = Object.fromEntries(
    LAYOUT_MODES.map((mode) => [mode, available]),
  ) as LayoutMenuProps["availability"];
  availability.coordinates = { reason: "noCoordinates", placed: 0, total: 4 };
  return {
    settings: layoutSettings(parseGraphOptions({}), "force"),
    availability,
    properties: { numbers: [], points: [], times: [], timesByLabel: new Map() },
    resolved: { coordinates: null, times: new Map() },
    labels: [],
    selection: [],
    centers: [],
    pinned: 0,
    onChange: vi.fn(),
    onRearrange: vi.fn(),
    onRelease: null,
    ...patch,
  };
}

const rows = () => screen.getAllByRole("menuitemradio");
const row = (mode: LayoutMode) => rows()[LAYOUT_MODES.indexOf(mode)] as HTMLElement;

describe("layout menu", () => {
  it("opens with ArrowDown, focuses the chosen row and moves with the arrow keys", async () => {
    const user = userEvent.setup();
    render(<LayoutMenu {...props()} />);
    const button = screen.getByRole("button", { name: "Layout: Forces" });
    button.focus();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("force"));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(row("hierarchy"));
    await user.keyboard("{ArrowUp}{ArrowUp}");
    // Wraps to the last row of the menu.
    expect(document.activeElement).not.toBe(row("force"));
    await user.keyboard("{Home}");
    expect(document.activeElement).toBe(row("force"));
  });

  it("has one Tab stop among the rows: the chosen one", async () => {
    const user = userEvent.setup();
    render(<LayoutMenu {...props()} />);
    await user.click(screen.getByRole("button", { name: "Layout: Forces" }));
    expect(rows().map((r) => r.tabIndex)).toEqual(
      LAYOUT_MODES.map((m) => (m === "force" ? 0 : -1)),
    );
    for (const item of screen.getAllByRole("menuitem")) expect(item.tabIndex).toBe(-1);
  });

  it("closes on Escape and returns the focus to its button", async () => {
    const user = userEvent.setup();
    render(<LayoutMenu {...props()} />);
    const button = screen.getByRole("button", { name: "Layout: Forces" });
    await user.click(button);
    expect(button.getAttribute("aria-expanded")).toBe("true");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("closes when Tab leaves its last stop, back on its button", async () => {
    const user = userEvent.setup();
    render(<LayoutMenu {...props()} />);
    const button = screen.getByRole("button", { name: "Layout: Forces" });
    await user.click(button);
    // Force has no options: the chosen row is the only and last stop.
    await user.keyboard("{Tab}");
    expect(screen.queryByRole("menu")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("chooses a layout that applies, and ignores a click on one that cannot", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<LayoutMenu {...props({ onChange })} />);
    await user.click(screen.getByRole("button", { name: "Layout: Forces" }));
    expect(row("coordinates").getAttribute("aria-disabled")).toBe("true");
    await user.click(row("coordinates"));
    expect(onChange).not.toHaveBeenCalled();
    await user.click(row("grid"));
    expect(onChange).toHaveBeenCalledWith({ mode: "grid" });
  });

  it("offers Arrange again only where it can change the result, and Release for pinned nodes", async () => {
    const user = userEvent.setup();
    const onRearrange = vi.fn();
    const onRelease = vi.fn();
    const { rerender } = render(<LayoutMenu {...props({ onRearrange, onRelease, pinned: 3 })} />);
    await user.click(screen.getByRole("button", { name: "Layout: Forces" }));
    await user.click(screen.getByRole("menuitem", { name: /Arrange again/ }));
    expect(onRearrange).toHaveBeenCalled();
    rerender(<LayoutMenu {...props({ onRearrange: null, onRelease, pinned: 3 })} />);
    await user.click(screen.getByRole("button", { name: "Layout: Forces" }));
    expect(screen.queryByRole("menuitem", { name: /Arrange again/ })).toBeNull();
    expect(screen.getByRole("menuitem", { name: /3/ })).toBeTruthy();
  });
});
