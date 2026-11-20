/**
 * Two letters that stand for a name where it has no picture (a plugin, a data source kind, an
 * app): the first letters of its first two words ("Energy meters" is "EM"), or the first two
 * letters of its one word ("Snowflake" is "Sn"). One rule, so a name carries the same letters
 * wherever it is shown.
 */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) {
    return `${words[0]?.[0] ?? ""}${words[1]?.[0] ?? ""}`.toUpperCase();
  }
  const word = words[0] ?? "?";
  return `${word.slice(0, 1).toUpperCase()}${word.slice(1, 2).toLowerCase()}`;
}
