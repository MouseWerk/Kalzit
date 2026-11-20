/** The letters and digits of a word, by code point: brackets, marks and emoji are no letters. */
function letters(word: string): string[] {
  return [...word].filter((char) => /\p{L}|\p{N}/u.test(char));
}

/**
 * Two letters that stand for a name where it has no picture (a plugin, a data source kind, an
 * app): the first letters of its first two words ("Energy meters" is "EM", "(Beta) Lager" is
 * "BL"), or the first two letters of its one word ("Snowflake" is "Sn"). A word without a letter
 * or digit does not count. One rule, so a name carries the same letters wherever it is shown.
 */
export function monogram(name: string): string {
  const words = name
    .trim()
    .split(/\s+/)
    .map(letters)
    .filter((word) => word.length > 0);
  const [first, second] = words;
  if (first === undefined) {
    return "?";
  }
  if (second !== undefined) {
    return `${first[0] ?? ""}${second[0] ?? ""}`.toUpperCase();
  }
  return `${(first[0] ?? "").toUpperCase()}${(first[1] ?? "").toLowerCase()}`;
}
