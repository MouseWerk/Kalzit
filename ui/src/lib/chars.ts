/**
 * The first `max` characters of `text`, counted as the server counts them (Unicode code points,
 * Rust's `chars()`), not in UTF-16 units: a character outside the Basic Multilingual Plane is
 * kept whole or left out, never cut into a lone surrogate the server would refuse.
 */
export function clipChars(text: string, max: number): string {
  // A string no longer than `max` UTF-16 units has at most `max` characters.
  if (text.length <= max) {
    return text;
  }
  return Array.from(text).slice(0, Math.max(0, max)).join("");
}
