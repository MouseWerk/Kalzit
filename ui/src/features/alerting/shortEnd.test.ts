import { describe, expect, it } from "vitest";
import { shortEndText } from "./shared";

/**
 * The end of a silence under a rule's state: the time on the same day, the day alone on another,
 * so the line is never longer than a time, whenever the list is read.
 */

const UTC = { timeZone: "UTC" };
const at = (iso: string) => Date.parse(iso);
/** Spaces as Intl writes them (a narrow no-break space before "PM"), made plain. */
const plain = (text: string) => text.replace(/\s/g, " ");

describe("shortEndText", () => {
  it("says the time when the end is on the same day", () => {
    const now = at("2026-11-24T21:00:00Z");
    expect(shortEndText(at("2026-11-24T22:58:00Z"), now, "de", UTC)).toBe("22:58");
    expect(plain(shortEndText(at("2026-11-24T22:58:00Z"), now, "en", UTC))).toBe("10:58 PM");
  });

  it("says the day alone when the end is on another day, also an hour after midnight", () => {
    const now = at("2026-11-24T23:30:00Z");
    expect(shortEndText(at("2026-11-25T00:30:00Z"), now, "de", UTC)).toBe("25.11.");
    expect(shortEndText(at("2026-11-25T00:30:00Z"), now, "en", UTC)).toBe("11/25");
    expect(shortEndText(at("2026-12-01T22:58:00Z"), now, "de", UTC)).toBe("01.12.");
  });

  it("adds the year when the end is in another year", () => {
    const now = at("2026-12-30T12:00:00Z");
    expect(shortEndText(at("2027-01-02T08:00:00Z"), now, "de", UTC)).toBe("02.01.2027");
    expect(shortEndText(at("2027-01-02T08:00:00Z"), now, "en", UTC)).toBe("01/02/2027");
    expect(shortEndText(at("2026-12-31T08:00:00Z"), now, "en", UTC)).toBe("12/31");
  });

  it("is never longer than the longest time within a year, whatever the clock says", () => {
    const longest = Math.max(
      ...["de", "en"].map((language) =>
        Math.max(
          shortEndText(at("2026-11-24T22:58:00Z"), at("2026-11-24T08:00:00Z"), language, UTC)
            .length,
          shortEndText(at("2026-12-28T22:58:00Z"), at("2026-11-24T08:00:00Z"), language, UTC)
            .length,
        ),
      ),
    );
    expect(longest).toBeLessThanOrEqual("10:58 PM".length);
  });

  it("reads the day in the given time zone", () => {
    // 23:30 in UTC is already the next day in Berlin, where the end at 00:50 is the same day;
    // an hour earlier it is not.
    const now = at("2026-11-24T23:30:00Z");
    const end = at("2026-11-24T23:50:00Z");
    expect(shortEndText(end, now, "de", { timeZone: "Europe/Berlin" })).toBe("00:50");
    expect(shortEndText(end, at("2026-11-24T22:30:00Z"), "de", { timeZone: "Europe/Berlin" })).toBe(
      "25.11.",
    );
  });
});
