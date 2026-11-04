import { expect, type Locator } from "@playwright/test";

/**
 * The Kalzit select (components/Select.tsx) is a combobox button whose list only exists while it
 * is open. These helpers open it and pick an option as a person does, in place of Playwright's
 * selectOption for native selects. A string matches an option's value or its label.
 */
export type SelectChoice = string | { label: string } | { value: string };

interface Timeout {
  timeout?: number;
}

/** The open list of `control`. */
export async function selectList(control: Locator, options: Timeout = {}): Promise<Locator> {
  if ((await control.getAttribute("aria-expanded", options)) !== "true") {
    await control.click(options);
  }
  await expect(control).toHaveAttribute("aria-expanded", "true", options);
  const id = await control.getAttribute("aria-controls", options);
  return control.page().locator(`[id="${id}"]`);
}

/** Opens the select and chooses one option. */
export async function selectOption(
  control: Locator,
  choice: SelectChoice,
  options: Timeout = {},
): Promise<void> {
  const list = await selectList(control, options);
  const quoted = (value: string) => value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  const byValue = (value: string) => list.locator(`[role="option"][data-value="${quoted(value)}"]`);
  const byLabel = (label: string) => list.getByRole("option", { name: label, exact: true });
  const option =
    typeof choice === "string"
      ? byValue(choice).or(byLabel(choice))
      : "label" in choice
        ? byLabel(choice.label)
        : byValue(choice.value);
  await option.first().click(options);
  await expect(control).toHaveAttribute("aria-expanded", "false", options);
}

/** The options of the select (it is opened for this and stays open). */
export async function selectOptionsOf(control: Locator, options: Timeout = {}): Promise<Locator> {
  return (await selectList(control, options)).getByRole("option");
}

/** Expects the select's chosen value, as toHaveValue does for a native select. */
export async function expectSelectValue(
  control: Locator,
  value: string,
  options: Timeout = {},
): Promise<void> {
  await expect(control).toHaveAttribute("value", value, options);
}
