import { findByRole, fireEvent } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/**
 * Helpers for the Kalzit select (components/Select.tsx) in tests: it is a combobox button whose
 * list of options only exists while it is open, so tests open it and click an option, as a
 * person does. An option is found by its value or its label, like user-event's selectOptions.
 */

function listOf(control: HTMLElement): HTMLElement {
  const id = control.getAttribute("aria-controls");
  const list = id === null ? null : document.getElementById(id);
  if (list === null) {
    throw new Error(`The select "${control.getAttribute("aria-label") ?? control.id}" is not open`);
  }
  return list;
}

function labelOf(option: HTMLElement): string {
  return option.querySelector(".select-option__label")?.textContent ?? option.textContent ?? "";
}

function findOption(list: HTMLElement, choice: string): HTMLElement {
  const options = [...list.querySelectorAll<HTMLElement>('[role="option"]')];
  const found =
    options.find((option) => option.dataset.value === choice) ??
    options.find((option) => labelOf(option) === choice);
  if (found === undefined) {
    throw new Error(
      `No option "${choice}" in the select; it offers: ${options.map(labelOf).join(", ")}`,
    );
  }
  return found;
}

/** Opens the select (when it is closed) and chooses the option with this value or label. */
export async function pickOption(
  user: UserEvent,
  control: HTMLElement,
  choice: string,
): Promise<void> {
  if (control.getAttribute("aria-expanded") !== "true") {
    await user.click(control);
  }
  await user.click(findOption(listOf(control), choice));
}

/** As pickOption, with synchronous events (for tests that use fake timers or fireEvent). */
export function chooseOption(control: HTMLElement, choice: string): void {
  if (control.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(control);
  }
  fireEvent.click(findOption(listOf(control), choice));
}

/** Opens the select and returns its option elements; it stays open. */
export function openOptions(control: HTMLElement): HTMLElement[] {
  if (control.getAttribute("aria-expanded") !== "true") {
    fireEvent.click(control);
  }
  return [...listOf(control).querySelectorAll<HTMLElement>('[role="option"]')];
}

/**
 * Waits until the select offers an option with this label (options that load later), then
 * closes it again. The list stays open while it waits: opening and closing inside a waitFor
 * callback would change the page on every check and never let the data arrive.
 */
export async function waitForOption(control: HTMLElement, label: string): Promise<void> {
  openOptions(control);
  await findByRole(listOf(control), "option", { name: label });
  fireEvent.keyDown(control, { key: "Escape" });
}

/** The labels of the select's options, in order; the select is closed again afterwards. */
export function optionLabels(control: HTMLElement): string[] {
  const wasOpen = control.getAttribute("aria-expanded") === "true";
  const labels = openOptions(control).map(labelOf);
  if (!wasOpen) {
    fireEvent.keyDown(control, { key: "Escape" });
  }
  return labels;
}

/** The values of the select's options, in order; the select is closed again afterwards. */
export function optionValues(control: HTMLElement): string[] {
  const wasOpen = control.getAttribute("aria-expanded") === "true";
  const values = openOptions(control).map((option) => option.dataset.value ?? "");
  if (!wasOpen) {
    fireEvent.keyDown(control, { key: "Escape" });
  }
  return values;
}
