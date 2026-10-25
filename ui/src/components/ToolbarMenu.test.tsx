import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ToolbarMenu } from "./ToolbarMenu";

describe("ToolbarMenu", () => {
  it("keeps an unavailable item in the arrow-key order and does nothing on it", async () => {
    const user = userEvent.setup();
    const first = vi.fn();
    const blocked = vi.fn();
    render(
      <ToolbarMenu
        label="More"
        icon="more"
        entries={[
          { key: "a", label: "Rename", onSelect: first },
          { key: "b", label: "Export", onSelect: blocked, disabled: true },
          { key: "c", label: "Delete", onSelect: vi.fn() },
        ]}
      />,
    );
    await user.click(screen.getByRole("button", { name: "More" }));
    const item = screen.getByRole("menuitem", { name: "Export" });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item).toHaveProperty("disabled", false);
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Rename" }));
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(item);
    await user.keyboard("{Enter}");
    expect(blocked).not.toHaveBeenCalled();
    expect(screen.getByRole("menu")).toBeTruthy();
    await user.keyboard("{ArrowDown}");
    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Delete" }));
  });
});
