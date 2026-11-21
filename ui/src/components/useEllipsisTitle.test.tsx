import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/**
 * The observer the hook shares between all its elements: it is made once and kept, so the fake
 * keeps what it was given on the class, across the tests of this file.
 */
class FakeResizeObserver {
  static made = 0;
  static report: (entries: { target: Element }[]) => void = () => undefined;
  static watched = new Set<Element>();
  constructor(callback: (entries: { target: Element }[]) => void) {
    FakeResizeObserver.made += 1;
    FakeResizeObserver.report = callback;
  }
  observe(element: Element) {
    FakeResizeObserver.watched.add(element);
  }
  unobserve(element: Element) {
    FakeResizeObserver.watched.delete(element);
  }
  disconnect() {}
}

const resized = (...elements: Element[]) =>
  act(() => FakeResizeObserver.report(elements.map((target) => ({ target }))));

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(document, "fonts");
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
    render(<Name text="Eigentümer" />);
    const name = screen.getByText("Eigentümer");
    expect(name.hasAttribute("title")).toBe(false);
    room = 60;
    resized(name);
    expect(name.getAttribute("title")).toBe("Eigentümer");
  });

  it("watches every text with one observer, and measures only the one that was resized", () => {
    const room: Record<string, number> = { Regeln: 200, Kontaktpunkte: 200 };
    vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(150);
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
      this: HTMLElement,
    ) {
      return room[this.textContent ?? ""] ?? 0;
    });
    const { unmount } = render(
      <>
        <Name text="Regeln" />
        <Name text="Kontaktpunkte" />
      </>,
    );
    const rules = screen.getByText("Regeln");
    const contacts = screen.getByText("Kontaktpunkte");
    expect(FakeResizeObserver.made).toBe(1);
    expect(FakeResizeObserver.watched.has(rules)).toBe(true);
    expect(FakeResizeObserver.watched.has(contacts)).toBe(true);
    // Both are narrower now, but only one was reported: the other keeps what it had.
    room.Regeln = 60;
    room.Kontaktpunkte = 60;
    resized(contacts);
    expect(contacts.getAttribute("title")).toBe("Kontaktpunkte");
    expect(rules.hasAttribute("title")).toBe(false);
    unmount();
    expect(FakeResizeObserver.watched.has(rules)).toBe(false);
    expect(FakeResizeObserver.watched.has(contacts)).toBe(false);
  });

  it("measures again once a web font has loaded: the text is wider, its box is not", () => {
    const fonts = new EventTarget();
    Object.defineProperty(document, "fonts", { value: fonts, configurable: true });
    let needed = 100;
    layOut(".name", () => ({ needed, room: 120 }));
    const { unmount } = render(<Name text="grace@example.com" />);
    const name = screen.getByText("grace@example.com");
    expect(name.hasAttribute("title")).toBe(false);
    // The font swapped in is wider than the fallback: no resize, the text is cut all the same.
    needed = 160;
    act(() => {
      fonts.dispatchEvent(new Event("loadingdone"));
    });
    expect(name.getAttribute("title")).toBe("grace@example.com");
    // A text that is gone is not measured any more.
    unmount();
    const measured = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get");
    measured.mockClear();
    fonts.dispatchEvent(new Event("loadingdone"));
    expect(measured).not.toHaveBeenCalled();
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
