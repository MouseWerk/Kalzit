import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { useMenuButton } from "./useMenuButton";

/** A menu whose items are given from outside, so a test can let some arrive after it opened. */
function Menu({ items }: { items: string[] }) {
  const menu = useMenuButton();
  return (
    <div ref={menu.anchorRef}>
      <button
        ref={menu.buttonRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={menu.open}
        onClick={menu.toggle}
        onKeyDown={menu.onButtonKeyDown}
      >
        Places
      </button>
      {menu.open ? (
        <div ref={menu.menuRef} role="menu" aria-label="Places" onKeyDown={menu.onMenuKeyDown}>
          {items.map((item) => (
            <button key={item} type="button" role="menuitem" tabIndex={-1}>
              {item}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function focusedText(): string | null | undefined {
  return document.activeElement?.textContent;
}

describe("menu button focus", () => {
  it("moves to the first item when items arrive ahead of the one it focused", async () => {
    // A server admin's menu: "All organizations" is known at once, the organization's own places
    // only once its permissions loaded.
    const user = userEvent.setup();
    const { rerender } = render(<Menu items={["All organizations"]} />);
    await user.click(screen.getByRole("button", { name: "Places" }));
    expect(focusedText()).toBe("All organizations");
    act(() => rerender(<Menu items={["Settings", "Members", "All organizations"]} />));
    expect(focusedText()).toBe("Settings");
  });

  it("waits for items when the menu opens empty", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Menu items={[]} />);
    await user.click(screen.getByRole("button", { name: "Places" }));
    act(() => rerender(<Menu items={["Settings", "Members"]} />));
    expect(focusedText()).toBe("Settings");
  });

  it("leaves focus where the person moved it when more items arrive", async () => {
    const user = userEvent.setup();
    const { rerender } = render(<Menu items={["Members", "Teams"]} />);
    await user.click(screen.getByRole("button", { name: "Places" }));
    await user.keyboard("{ArrowDown}");
    expect(focusedText()).toBe("Teams");
    act(() => rerender(<Menu items={["Settings", "Members", "Teams"]} />));
    expect(focusedText()).toBe("Teams");
  });

  it("opens on the last item with the up arrow", async () => {
    const user = userEvent.setup();
    render(<Menu items={["Settings", "Members"]} />);
    screen.getByRole("button", { name: "Places" }).focus();
    await user.keyboard("{ArrowUp}");
    expect(focusedText()).toBe("Members");
  });
});
