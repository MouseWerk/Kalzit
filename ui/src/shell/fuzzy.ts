/**
 * How well `needle` matches `hay`; undefined when it does not match at all. Both are compared in
 * lower case. The server ranks its search results by the same rules (`fuzzy_score` in
 * server/src/routes/home.rs), so entries of the command palette that come from the server and
 * from the UI (sections, actions) sort together:
 *
 * the whole text 1000, a prefix 900 minus the extra length, a substring at a word start 800 minus
 * its position, any substring 700 minus its position, and the letters in order at most 599 (more
 * for adjacent letters and word starts, less for gaps).
 */
export function fuzzyScore(rawNeedle: string, rawHay: string): number | undefined {
  const needle = Array.from(rawNeedle.trim().toLowerCase());
  const hay = Array.from(rawHay.toLowerCase());
  if (needle.length === 0) {
    return 0;
  }
  const capped = (n: number) => Math.min(n, 99);
  const needleText = needle.join("");
  const hayText = hay.join("");
  if (hayText === needleText) {
    return 1000;
  }
  if (hayText.startsWith(needleText)) {
    return 900 - capped(hay.length - needle.length);
  }
  const wordStart = (i: number) => i === 0 || !/[\p{L}\p{N}]/u.test(hay[i - 1] ?? "");
  let firstAt: number | undefined;
  for (let start = 0; start + needle.length <= hay.length; start++) {
    if (needle.every((c, i) => hay[start + i] === c)) {
      if (wordStart(start)) {
        return 800 - capped(start);
      }
      firstAt ??= start;
    }
  }
  if (firstAt !== undefined) {
    return 700 - capped(firstAt);
  }
  let score = 100;
  let gaps = 0;
  let previous: number | undefined;
  let at = 0;
  for (const c of needle) {
    let found = -1;
    for (let i = at; i < hay.length; i++) {
      if (hay[i] === c) {
        found = i;
        break;
      }
    }
    if (found === -1) {
      return undefined;
    }
    if (previous === undefined) {
      gaps += found;
    } else if (found === previous + 1) {
      score += 10;
    } else {
      gaps += found - previous - 1;
    }
    if (wordStart(found)) {
      score += 15;
    }
    previous = found;
    at = found + 1;
  }
  return Math.min(Math.max(score - capped(gaps), 1), 599);
}
