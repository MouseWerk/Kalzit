import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { Dialog } from "../features/dashboards/ui/Dialog";
import { optionLabels, pickOption } from "../test/select";
import { Select } from "./Select";

const FRUITS = ["Apple", "Banana", "Blueberry", "Cherry", "Date"];

function Fruit({
  initial = "Banana",
  count = FRUITS.length,
}: {
  initial?: string;
  count?: number;
}) {
  const [value, setValue] = useState(initial);
  const names = Array.from({ length: count }, (_, i) => FRUITS[i] ?? `Fruit ${i}`);
  return (
    <form aria-label="Order">
      <label htmlFor="fruit">Fruit</label>
      <Select id="fruit" name="fruit" value={value} onChange={setValue} aria-describedby="hint">
        {names.map((name) => (
          <option key={name} value={name.toLowerCase()} disabled={name === "Cherry"}>
            {name}
          </option>
        ))}
      </Select>
      <p id="hint">Pick one</p>
      <output>{value}</output>
    </form>
  );
}

function Grouped({ onClose }: { onClose: () => void }) {
  const [value, setValue] = useState("a");
  return (
    <Dialog title="Pick" onClose={onClose}>
      <Select aria-label="Letter" value={value} onChange={setValue}>
        <optgroup label="First">
          <option value="a">A</option>
        </optgroup>
        <optgroup label="Second">
          <option value="b">B</option>
        </optgroup>
      </Select>
    </Dialog>
  );
}

describe("Select", () => {
  it("is a labelled combobox that keeps its description and value", () => {
    render(<Fruit initial="banana" />);
    const control = screen.getByRole("combobox", { name: "Fruit" });
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(control.getAttribute("aria-describedby")).toBe("hint");
    expect((control as HTMLButtonElement).value).toBe("banana");
    expect(control.textContent).toContain("Banana");
    const form = screen.getByRole("form", { name: "Order" }) as HTMLFormElement;
    expect(new FormData(form).get("fruit")).toBe("banana");
  });

  it("opens with the keys, moves, skips disabled options and chooses with Enter", async () => {
    const user = userEvent.setup();
    render(<Fruit initial="banana" />);
    const control = screen.getByRole("combobox", { name: "Fruit" });
    control.focus();
    await user.keyboard("{ArrowDown}");
    expect(control.getAttribute("aria-expanded")).toBe("true");
    const list = screen.getByRole("listbox", { name: "Fruit" });
    const active = () =>
      document.getElementById(control.getAttribute("aria-activedescendant") ?? "");
    expect(active()?.textContent).toBe("Banana");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // Cherry is disabled: skipped.
    expect(active()?.textContent).toBe("Date");
    await user.keyboard("{Home}");
    expect(active()?.textContent).toBe("Apple");
    await user.keyboard("{End}{Enter}");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(control);
    expect(list.isConnected).toBe(false);
    expect((control as HTMLButtonElement).value).toBe("date");
  });

  it("jumps to typed letters and closes on Escape without a change", async () => {
    const user = userEvent.setup();
    render(<Fruit initial="apple" />);
    const control = screen.getByRole("combobox", { name: "Fruit" });
    control.focus();
    await user.keyboard("b");
    const active = () =>
      document.getElementById(control.getAttribute("aria-activedescendant") ?? "");
    expect(active()?.textContent).toBe("Banana");
    await user.keyboard("l");
    expect(active()?.textContent).toBe("Blueberry");
    await user.keyboard("{Escape}");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect((control as HTMLButtonElement).value).toBe("apple");
  });

  it("chooses with the pointer and marks the chosen option", async () => {
    const user = userEvent.setup();
    render(<Fruit initial="apple" />);
    const control = screen.getByRole("combobox", { name: "Fruit" });
    await pickOption(user, control, "Date");
    expect((control as HTMLButtonElement).value).toBe("date");
    await user.click(control);
    const chosen = screen.getByRole("option", { selected: true });
    expect(chosen.textContent).toBe("Date");
    expect(screen.getByRole("option", { name: "Cherry" }).getAttribute("aria-disabled")).toBe(
      "true",
    );
  });

  it("offers a search field for long lists", async () => {
    const user = userEvent.setup();
    render(<Fruit initial="apple" count={20} />);
    const control = screen.getByRole("combobox", { name: "Fruit" });
    await user.click(control);
    const search = screen.getByRole("combobox", { name: "Search options" });
    expect(document.activeElement).toBe(search);
    await user.keyboard("fruit 1");
    const list = screen.getByRole("listbox", { name: "Fruit" });
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `Fruit 1${i}`));
    await user.keyboard("{ArrowDown}{Enter}");
    expect((control as HTMLButtonElement).value).toBe("fruit 11");
    expect(document.activeElement).toBe(control);
  });

  it("shows groups and closes before a surrounding dialog on Escape", async () => {
    const user = userEvent.setup();
    let closed = false;
    render(
      <Grouped
        onClose={() => {
          closed = true;
        }}
      />,
    );
    const control = screen.getByRole("combobox", { name: "Letter" });
    expect(optionLabels(control)).toEqual(["A", "B"]);
    await user.click(control);
    expect(screen.getByRole("group", { name: "Second" })).toBeTruthy();
    await user.keyboard("{Escape}");
    expect(control.getAttribute("aria-expanded")).toBe("false");
    expect(closed).toBe(false);
  });
});
