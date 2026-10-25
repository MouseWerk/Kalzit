import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { App, createApp } from "../app/app";
import { Toaster } from "../components/Toaster";
import { dismissToast, showToast, UNDO_TOAST_MS } from "../lib/toasts";
import { browserHistoryAt } from "../test/browserHistory";
import { installFakeServer, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

function setup() {
  installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
}

describe("undo toasts", () => {
  it("keep a pending Undo when a plain confirmation follows", () => {
    render(<Toaster />);
    const undo = vi.fn();
    act(() => {
      showToast({ message: "Deleted it.", undo });
      showToast({ message: "Saved something else." });
    });
    expect(screen.getByText("Deleted it.")).toBeTruthy();
    expect(screen.getByText("Saved something else.")).toBeTruthy();
    act(() => screen.getByRole("button", { name: "Undo" }).click());
    expect(undo).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Deleted it.")).toBeNull();
    // A newer Undo replaces the older one: the last change is what can be undone.
    act(() => {
      showToast({ message: "First.", undo: () => {} });
      showToast({ message: "Second.", undo: () => {} });
    });
    expect(screen.queryByText("First.")).toBeNull();
    expect(screen.getByText("Second.")).toBeTruthy();
    act(() => dismissToast());
  });

  it("wait while the pointer is on them, and say how to reach Undo", () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => {
        showToast({ message: "Removed.", undo: () => {} });
      });
      expect(screen.getByText("Press F6 to reach Undo.")).toBeTruthy();
      const toast = screen.getByText("Removed.").closest(".toast") as HTMLElement;
      fireEvent.pointerEnter(toast);
      act(() => vi.advanceTimersByTime(UNDO_TOAST_MS * 3));
      expect(screen.getByText("Removed.")).toBeTruthy();
      fireEvent.pointerLeave(toast);
      act(() => vi.advanceTimersByTime(UNDO_TOAST_MS + 1));
      expect(screen.queryByText("Removed.")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("are reached with F6 from the content, and F6 goes on to the navigation", async () => {
    setup();
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    act(() => {
      showToast({ message: "Removed it.", undo: () => {} });
    });
    await screen.findByText("Removed it.");
    screen.getByRole("main").focus();
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
    await user.keyboard("{F6}");
    expect(
      screen.getByRole("navigation", { name: "Main navigation" }).contains(document.activeElement),
    ).toBe(true);
    act(() => dismissToast());
  });
});

describe("F6 with several toasts", () => {
  it("still reaches the Undo toast while an error toast shows", async () => {
    setup();
    const { user } = renderApp("/");
    await screen.findByRole("navigation", { name: "Main navigation" });
    act(() => {
      showToast({ message: "That failed.", error: true });
      showToast({ message: "Removed it.", undo: () => {} });
    });
    await screen.findByText("Removed it.");
    screen.getByRole("main").focus();
    await user.keyboard("{F6}");
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Undo" }));
    await user.keyboard("{F6}");
    expect(document.activeElement?.closest(".toast")?.textContent).toContain("That failed.");
    act(() => dismissToast());
  });

  it("holds the toast while focus is inside, even after the pointer left", () => {
    vi.useFakeTimers();
    try {
      render(<Toaster />);
      act(() => {
        showToast({ message: "Removed.", undo: () => {} });
      });
      const toast = screen.getByText("Removed.").closest(".toast") as HTMLElement;
      fireEvent.pointerEnter(toast);
      act(() => screen.getByRole("button", { name: "Undo" }).focus());
      fireEvent.pointerLeave(toast);
      act(() => vi.advanceTimersByTime(UNDO_TOAST_MS * 3));
      expect(screen.getByText("Removed.")).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("the Back button", () => {
  it("closes the shortcut help instead of leaving it over the page", async () => {
    setup();
    const { history, destroy } = browserHistoryAt("/dashboards", "/");
    const app = createApp({ history, retry: false });
    const { user } = { user: userEvent.setup() };
    render(<App app={app} />);
    await screen.findByRole("navigation", { name: "Main navigation" });
    await user.keyboard("?");
    expect(await screen.findByRole("dialog", { name: "Keyboard shortcuts" })).toBeTruthy();
    act(() => window.history.back());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    // The overlay took the press; the page stays.
    expect(app.router.state.location.pathname).toBe("/");
    destroy();
  });
});
