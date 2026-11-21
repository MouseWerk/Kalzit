import { describe, expect, it } from "vitest";
import { monogram } from "./monogram";

describe("monogram", () => {
  it("takes the first letters of two words, or two letters of one", () => {
    expect(monogram("Energy meters")).toBe("EM");
    expect(monogram("Snowflake")).toBe("Sn");
    expect(monogram("SAP HANA")).toBe("SH");
    expect(monogram("  kapazitätsplanung   lager nord ")).toBe("KL");
  });

  it("counts letters and digits only, by code point", () => {
    expect(monogram("(Beta) Lager")).toBe("BL");
    expect(monogram("\u{1F680} Rocket planner")).toBe("RP");
    expect(monogram("\u{1F680}Rocket")).toBe("Ro");
    expect(monogram("3D viewer")).toBe("3V");
    // A letter outside the basic plane is one letter, not half of one.
    expect(monogram("𝒜lpha")).toBe("𝒜l");
  });

  it("answers a question mark for a name without a letter", () => {
    expect(monogram("")).toBe("?");
    expect(monogram("\u{1F680} \u{2728}")).toBe("?");
  });
});
