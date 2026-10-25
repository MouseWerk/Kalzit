import { describe, expect, it } from "vitest";
import { ApiError } from "../../../api/client";
import { type Translate, translate } from "../../../i18n/i18n";
import { errorBodyMessage, errorMessage, requestIdOf } from "./errors";

const t: Translate = (key, params) => translate("de", key, params);

describe("internal errors", () => {
  it("show the request id the server logged", () => {
    const error = new ApiError("internal", 500, "internal error", undefined, {
      error: { code: "internal", message: "x", requestId: "ab12cd34ef56" },
    });
    expect(errorMessage(t, error)).toContain("Anfrage-ID: ab12cd34ef56");
    expect(
      errorBodyMessage(t, { code: "internal", message: "x", requestId: "ab12cd34ef56" }),
    ).toContain("Anfrage-ID: ab12cd34ef56");
  });

  it("read without an id as before", () => {
    expect(requestIdOf({ error: { code: "internal" } })).toBeUndefined();
    expect(errorBodyMessage(t, { code: "internal", message: "x" })).not.toContain("Anfrage-ID");
  });
});
