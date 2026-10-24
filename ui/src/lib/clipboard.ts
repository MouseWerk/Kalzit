/**
 * The clipboard, where the browser offers it. Over plain HTTP (no secure context) and in some
 * embedded browsers `navigator.clipboard` is missing; a denied permission rejects. Both answer
 * false or null here instead of throwing, so the caller can say so.
 */

export async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard === undefined) {
      return false;
    }
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export async function readClipboard(): Promise<string | null> {
  try {
    if (navigator.clipboard === undefined) {
      return null;
    }
    return await navigator.clipboard.readText();
  } catch {
    return null;
  }
}
