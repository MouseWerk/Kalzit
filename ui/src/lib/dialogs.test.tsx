import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Toaster } from "../components/Toaster";
import {
  ConfirmDialog as AdminConfirm,
  Dialog as AdminDialog,
} from "../features/admin/components/Dialog";
import { ConfirmDialog, Dialog } from "../features/dashboards/ui/Dialog";

afterEach(cleanup);

function renderIn(ui: React.ReactNode) {
  return render(
    <>
      {ui}
      <Toaster />
    </>,
  );
}

function back() {
  act(() => {
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
}

describe("dialogs", () => {
  it("are described by their confirmation text", () => {
    renderIn(
      <>
        <ConfirmDialog
          title="Delete A"
          confirmLabel="Delete"
          onConfirm={vi.fn()}
          onCancel={vi.fn()}
        >
          Cannot be undone A.
        </ConfirmDialog>
        <AdminConfirm
          open
          title="Delete B"
          confirmLabel="Delete"
          onConfirm={vi.fn()}
          onClose={vi.fn()}
        >
          Cannot be undone B.
        </AdminConfirm>
      </>,
    );
    for (const [name, text] of [
      ["Delete A", "Cannot be undone A."],
      ["Delete B", "Cannot be undone B."],
    ] as const) {
      const dialog = screen.getByRole("dialog", { name });
      expect(dialog.getAttribute("aria-describedby")).not.toBeNull();
      const id = dialog.getAttribute("aria-describedby") as string;
      expect(document.getElementById(id)?.textContent).toBe(text);
    }
  });

  it("keep Tab inside, also from the dialog itself, and skip hidden controls", () => {
    for (const which of ["dashboards", "admin"] as const) {
      const body = (
        <>
          <button type="button">Last</button>
          <div hidden>
            <button type="button">Hidden</button>
          </div>
        </>
      );
      const { unmount } = renderIn(
        which === "dashboards" ? (
          <Dialog title="Trap" onClose={vi.fn()}>
            {body}
          </Dialog>
        ) : (
          <AdminDialog open title="Trap" onClose={vi.fn()}>
            {body}
          </AdminDialog>
        ),
      );
      const dialog = screen.getByRole("dialog", { name: "Trap" });
      const last = screen.getByRole("button", { name: "Last" });
      // A click on the dialog's background puts the focus on the dialog: Shift+Tab stays in,
      // on the last control Tab can reach (the hidden one comes later but is no stop).
      act(() => dialog.focus());
      fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
      expect(document.activeElement, which).toBe(last);
      fireEvent.keyDown(last, { key: "Tab" });
      expect(dialog.querySelector("button"), which).toBe(document.activeElement);
      unmount();
    }
  });

  it("close when the Back button is pressed, without leaving input behind", () => {
    const onClose = vi.fn();
    const onAdminClose = vi.fn();
    renderIn(
      <>
        <Dialog title="A" onClose={onClose}>
          <input aria-label="Name" />
        </Dialog>
        <AdminDialog open title="B" onClose={onAdminClose}>
          <input aria-label="Other" />
        </AdminDialog>
      </>,
    );
    back();
    // Only the topmost one answers (the admin dialog mounted last).
    expect(onAdminClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("stay open and say so when the Back button comes with typed input", () => {
    const onClose = vi.fn();
    renderIn(
      <Dialog title="A" onClose={onClose}>
        <input aria-label="Name" />
      </Dialog>,
    );
    const input = screen.getByRole("textbox", { name: "Name" });
    fireEvent.input(input, { target: { value: "Ada" } });
    back();
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByText(/Back and Escape keep what you typed/)).toBeTruthy();
  });
});
