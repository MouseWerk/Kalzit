/**
 * Whether the user last used the keyboard or a pointer. Focus that follows a key press (Tab, F6)
 * opens the rail's flyout as a layer and shows the rail's tooltips; focus that follows a click
 * does not.
 */
let keyboard = false;
let installed = false;

function onKeyDown(event: KeyboardEvent): void {
  // Modifier keys alone do not move focus.
  if (!["Shift", "Control", "Alt", "Meta"].includes(event.key)) {
    keyboard = true;
  }
}

function onPointerDown(): void {
  keyboard = false;
}

/** Starts tracking; safe to call more than once. */
export function trackInputModality(): void {
  if (installed) {
    return;
  }
  installed = true;
  document.addEventListener("keydown", onKeyDown, true);
  document.addEventListener("pointerdown", onPointerDown, true);
}

export function lastInputWasKeyboard(): boolean {
  return keyboard;
}
