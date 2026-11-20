import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Select } from "./Select";
import { useEllipsisTitle } from "./useEllipsisTitle";

/**
 * The tooltip of a text that is cut with an ellipsis. jsdom lays nothing out, so the widths are
 * given: `scrollWidth` is what the text needs, `clientWidth` what the element has.
 */

function layOut(selector: string, widths: () => { needed: number; room: number }) {
  vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.matches(selector) ? widths().needed : 0;
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.matches(selector) ? widths().room : 0;
  });
}

function Name({ text }: { text: string }) {
  const cut = useEllipsisTitle<HTMLSpanElement>(text);
  return (
    <span ref={cut.ref} className="name" title={cut.title}>
      {text}
    </span>
  );
}

function Role({ title }: { title?: string }) {
  return (
    <Select aria-label="Rolle" value="owner" onChange={() => undefined} title={title}>
      <option value="owner">Eigentümer</option>
      <option value="viewer">Betrachter</option>
    </Select>
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("useEllipsisTitle", () => {
  it("gives the whole text as the title while the element cuts it", () => {
    layOut(".name", () => ({ needed: 180, room: 120 }));
    render(<Name text="Benachrichtigungsrichtlinien" />);
    expect(screen.getByText("Benachrichtigungsrichtlinien").getAttribute("title")).toBe(
      "Benachrichtigungsrichtlinien",
    );
  });

  it("gives no title while the text fits, so the tooltip never repeats what is on screen", () => {
    layOut(".name", () => ({ needed: 120, room: 120 }));
    render(<Name text="Regeln" />);
    expect(screen.getByText("Regeln").hasAttribute("title")).toBe(false);
  });

  it("measures a new text anew", () => {
    const needed: Record<string, number> = { Kurz: 40, "Ein sehr langer Name": 200 };
    let shown = "Kurz";
    layOut(".name", () => ({ needed: needed[shown] ?? 0, room: 120 }));
    const { rerender } = render(<Name text={shown} />);
    expect(screen.getByText("Kurz").hasAttribute("title")).toBe(false);
    shown = "Ein sehr langer Name";
    rerender(<Name text={shown} />);
    expect(screen.getByText(shown).getAttribute("title")).toBe(shown);
  });

  it("follows the element's width", () => {
    let room = 200;
    layOut(".name", () => ({ needed: 150, room }));
    let resized: () => void = () => undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: () => void) {
          resized = callback;
        }
        observe() {}
        disconnect() {}
      },
    );
    render(<Name text="Eigentümer" />);
    const name = screen.getByText("Eigentümer");
    expect(name.hasAttribute("title")).toBe(false);
    room = 60;
    act(() => resized());
    expect(name.getAttribute("title")).toBe("Eigentümer");
  });
});

describe("Select", () => {
  it("shows its value as a tooltip when the control is too narrow for it, however short", () => {
    layOut(".select__label", () => ({ needed: 71, room: 12 }));
    render(<Role />);
    expect(screen.getByRole("combobox", { name: "Rolle" }).getAttribute("title")).toBe(
      "Eigentümer",
    );
  });

  it("shows no tooltip while the value fits, and keeps a title it was given", () => {
    layOut(".select__label", () => ({ needed: 71, room: 120 }));
    const { unmount } = render(<Role />);
    expect(screen.getByRole("combobox", { name: "Rolle" }).hasAttribute("title")).toBe(false);
    unmount();
    render(<Role title="Rolle im Team" />);
    expect(screen.getByRole("combobox", { name: "Rolle" }).getAttribute("title")).toBe(
      "Rolle im Team",
    );
  });
});
