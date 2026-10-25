/**
 * Whether a key event belongs to an input method composition (Enter that confirms a candidate,
 * Escape that cancels one). Some browsers report the confirming key after `isComposing` is
 * already false, but with keyCode 229, so both are checked. Handlers for Enter and Escape on
 * text inputs return early when this is true.
 */
export function isComposingKey(event: {
  nativeEvent?: { isComposing?: boolean };
  isComposing?: boolean;
  keyCode?: number;
}): boolean {
  return (
    event.isComposing === true || event.nativeEvent?.isComposing === true || event.keyCode === 229
  );
}
