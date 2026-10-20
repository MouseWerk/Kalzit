import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type ReactNode, useState } from "react";
import { describe, expect, it } from "vitest";
import { openLayerCount, useEscapeLayer } from "./layers";

/** A layer that the user opens with a button, the way dialogs and menus open in the app. */
function Layer({ name, children }: { name: string; children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  useEscapeLayer(open, () => setOpen(false));
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        open {name}
      </button>
      {open ? (
        <div>
          <p>{name} open</p>
          {children}
        </div>
      ) : null}
    </div>
  );
}

describe("useEscapeLayer", () => {
  it("closes only the topmost layer per Escape", async () => {
    const user = userEvent.setup();
    render(
      <Layer name="dialog">
        <Layer name="menu" />
      </Layer>,
    );
    await user.click(screen.getByRole("button", { name: "open dialog" }));
    await user.click(screen.getByRole("button", { name: "open menu" }));
    expect(openLayerCount()).toBe(2);

    await user.keyboard("{Escape}");
    expect(screen.queryByText("menu open")).toBeNull();
    expect(screen.getByText("dialog open")).toBeTruthy();
    expect(openLayerCount()).toBe(1);

    await user.keyboard("{Escape}");
    expect(screen.queryByText("dialog open")).toBeNull();
    expect(openLayerCount()).toBe(0);
  });

  it("leaves Escape alone while no layer is open", async () => {
    const user = userEvent.setup();
    render(<Layer name="menu" />);
    let seen = false;
    const listener = (event: KeyboardEvent) => {
      seen = event.key === "Escape" && !event.defaultPrevented;
    };
    document.addEventListener("keydown", listener);
    try {
      await user.keyboard("{Escape}");
    } finally {
      document.removeEventListener("keydown", listener);
    }
    expect(seen).toBe(true);
  });

  it("unregisters when unmounted", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Layer name="menu" />);
    await user.click(screen.getByRole("button", { name: "open menu" }));
    expect(openLayerCount()).toBe(1);
    unmount();
    expect(openLayerCount()).toBe(0);
  });
});
