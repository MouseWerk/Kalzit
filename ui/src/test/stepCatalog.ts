import { screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

/** Opens the step catalog with "Add step"; `scope` is where that button is. */
export async function openCatalog(user: UserEvent, scope: HTMLElement = document.body) {
  await user.click(within(scope).getByRole("button", { name: "Add step" }));
  return screen.getByRole("dialog", { name: "Add step" });
}

/** The entries of the catalog, by the name of their step. */
export function catalogOptions(dialog: HTMLElement): HTMLElement[] {
  return within(dialog).queryAllByRole("option");
}

const nameOf = (option: HTMLElement) =>
  option.querySelector(".step-catalog__name")?.textContent ?? "";

/** The names of the steps the catalog lists now. */
export function catalogNames(dialog: HTMLElement): string[] {
  return catalogOptions(dialog).map(nameOf);
}

/** The entry of the step named `name`. */
export function catalogOption(dialog: HTMLElement, name: string): HTMLElement {
  const found = catalogOptions(dialog).find((o) => nameOf(o) === name);
  if (found === undefined) {
    throw new Error(`no step ${name} in the catalog: ${catalogNames(dialog).join(", ")}`);
  }
  return found;
}

/** Chooses the shape the catalog shows steps for ("Table", "Graph", "Trace"). */
export async function chooseShape(user: UserEvent, dialog: HTMLElement, shape: string) {
  const radio = within(dialog)
    .getAllByRole("radio")
    .find((r) => r.textContent?.startsWith(`${shape} ·`));
  if (radio === undefined) throw new Error(`no shape ${shape} in the catalog`);
  await user.click(radio);
}

/** Adds the step named `name` through the catalog, after choosing `shape` when given. */
export async function addStep(
  user: UserEvent,
  name: string,
  { shape, scope }: { shape?: string; scope?: HTMLElement } = {},
) {
  const dialog = await openCatalog(user, scope);
  if (shape !== undefined) await chooseShape(user, dialog, shape);
  await user.click(catalogOption(dialog, name));
}

/** The step names the catalog lists for `shape` (the first shape when absent); closes it again. */
export async function offeredSteps(
  user: UserEvent,
  { shape, scope }: { shape?: string; scope?: HTMLElement } = {},
): Promise<{ names: string[]; unavailable: string[] }> {
  const dialog = await openCatalog(user, scope);
  if (shape !== undefined) await chooseShape(user, dialog, shape);
  const options = catalogOptions(dialog);
  const result = {
    names: options.map(nameOf),
    unavailable: options.filter((o) => o.getAttribute("aria-disabled") === "true").map(nameOf),
  };
  await user.keyboard("{Escape}");
  return result;
}
