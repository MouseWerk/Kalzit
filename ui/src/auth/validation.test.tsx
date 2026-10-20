import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import { safeRedirect } from "./redirect";
import {
  characterCount,
  fieldFromServer,
  firstInvalid,
  MAX_NAME_LENGTH,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  preventComposingSubmit,
  trimWhitespace,
  validateLogin,
  validateSetup,
} from "./validation";

const VALID_SETUP = {
  token: "abc",
  orgName: "Org",
  name: "Ada",
  email: "ada@example.com",
  password: "a".repeat(MIN_PASSWORD_LENGTH),
};

const keyOf = (message: { key: string } | undefined) => message?.key;

describe("validateSetup", () => {
  it("accepts a complete form", () => {
    expect(validateSetup(VALID_SETUP)).toEqual({});
  });

  it("reports every missing field, treating whitespace as empty", () => {
    expect(
      validateSetup({ token: " ", orgName: "\t", name: "", email: "  ", password: "" }),
    ).toEqual({
      token: { key: "validation.tokenRequired" },
      orgName: { key: "validation.orgNameRequired" },
      name: { key: "validation.nameRequired" },
      email: { key: "validation.emailRequired" },
      password: { key: "validation.passwordRequired" },
    });
  });

  it("needs 12 to 1024 characters for the password and says the limit", () => {
    expect(validateSetup({ ...VALID_SETUP, password: "a".repeat(11) }).password).toEqual({
      key: "validation.passwordTooShort",
      params: { count: 12 },
    });
    expect(validateSetup({ ...VALID_SETUP, password: "a".repeat(12) }).password).toBeUndefined();
    expect(
      validateSetup({ ...VALID_SETUP, password: "a".repeat(MAX_PASSWORD_LENGTH) }).password,
    ).toBeUndefined();
    expect(
      validateSetup({ ...VALID_SETUP, password: "a".repeat(MAX_PASSWORD_LENGTH + 1) }).password,
    ).toEqual({ key: "validation.passwordTooLong", params: { count: 1024 } });
  });

  it("counts characters, not UTF-16 units", () => {
    // U+1D538 is one character but two UTF-16 units; eleven of them are still too short.
    const elevenWide = "\u{1D538}".repeat(11);
    expect(elevenWide.length).toBe(22);
    expect(characterCount(elevenWide)).toBe(11);
    expect(keyOf(validateSetup({ ...VALID_SETUP, password: elevenWide }).password)).toBe(
      "validation.passwordTooShort",
    );
    // 1024 wide characters are 2048 UTF-16 units and still allowed.
    const maxWide = "\u{1D538}".repeat(MAX_PASSWORD_LENGTH);
    expect(validateSetup({ ...VALID_SETUP, password: maxWide }).password).toBeUndefined();
    expect(validateSetup({ ...VALID_SETUP, password: "Passwörter-äö" }).password).toBeUndefined();
  });

  it("does not trim the password, since spaces are part of it", () => {
    expect(validateSetup({ ...VALID_SETUP, password: " ".repeat(12) }).password).toBeUndefined();
  });

  it("allows names and organization names of 1 to 100 characters after trimming", () => {
    const longest = "\u{1D538}".repeat(MAX_NAME_LENGTH);
    expect(validateSetup({ ...VALID_SETUP, name: `  ${longest}  `, orgName: "A" })).toEqual({});
    const tooLong = validateSetup({ ...VALID_SETUP, name: `${longest}x`, orgName: `${longest}x` });
    expect(tooLong.name).toEqual({ key: "validation.tooLong", params: { count: 100 } });
    expect(tooLong.orgName).toEqual({ key: "validation.tooLong", params: { count: 100 } });
  });

  it.each(["Ada\nLovelace", "Ada\u0000", "Org\tName"])(
    "rejects control characters inside %j",
    (value) => {
      const result = validateSetup({ ...VALID_SETUP, name: value, orgName: value });
      expect(keyOf(result.name)).toBe("validation.controlCharacters");
      expect(keyOf(result.orgName)).toBe("validation.controlCharacters");
    },
  );

  it.each([
    "no-at-sign",
    "two@@example.com",
    "spa ce@example.com",
    "@example.com",
    "ada@",
    "ada@localhost",
    "ada@.example.com",
    "ada@example.com.",
    "ada@exa\u0000mple.com",
    // U+0085 (next line) is white space for the server, though not for JS's \s.
    "ada@exa\u0085mple.com",
    "ad\u2003a@example.com",
  ])("rejects the email address %j", (email) => {
    expect(keyOf(validateSetup({ ...VALID_SETUP, email }).email)).toBe("validation.emailInvalid");
  });

  it.each([
    "ada@example.com",
    "a+tag@sub.example.co.uk",
    "zoë@exämple.de",
    " ada@example.com ",
    "\u0085ada@example.com\u3000",
    // U+FEFF is no white space for the server, though JS's \s matches it.
    "ada@exa\uFEFFmple.com",
  ])("accepts the email address %j", (email) => {
    expect(validateSetup({ ...VALID_SETUP, email }).email).toBeUndefined();
  });
});

describe("trimWhitespace", () => {
  it("trims Unicode White_Space like the server, keeping U+FEFF", () => {
    expect(trimWhitespace("\u0085\u00a0 Ada \u3000\n")).toBe("Ada");
    expect(trimWhitespace("\uFEFFAda\uFEFF")).toBe("\uFEFFAda\uFEFF");
  });
});

describe("validateLogin", () => {
  it.each(["ada@localhost", "two@@example.com", "ada@example.com."])(
    "accepts %s, since sign-in checks no address shape",
    (email) => {
      expect(validateLogin({ email, password: "x" })).toEqual({});
    },
  );

  it("only asks for an @ in the address", () => {
    expect(keyOf(validateLogin({ email: "ada", password: "x" }).email)).toBe(
      "validation.emailInvalid",
    );
  });

  it("has no length rule for an existing password", () => {
    expect(validateLogin({ email: "ada@example.com", password: "short" })).toEqual({});
  });

  it("requires both fields", () => {
    expect(validateLogin({ email: "", password: "" })).toEqual({
      email: { key: "validation.emailRequired" },
      password: { key: "validation.passwordRequired" },
    });
  });
});

describe("fieldFromServer", () => {
  it("returns the field a validation error names, if the form has it", () => {
    const order = ["email", "password"] as const;
    expect(fieldFromServer(order, new ApiError("validation", 400, "", "email"))).toBe("email");
    expect(fieldFromServer(order, new ApiError("validation", 400, "", "token"))).toBeUndefined();
    expect(fieldFromServer(order, new ApiError("validation", 400, ""))).toBeUndefined();
    expect(fieldFromServer(order, new ApiError("forbidden", 403, "", "email"))).toBeUndefined();
  });
});

describe("firstInvalid", () => {
  it("follows the order of the form, not of the error object", () => {
    expect(
      firstInvalid(["token", "name", "password"], {
        password: { key: "validation.passwordRequired" },
        name: { key: "validation.nameRequired" },
      }),
    ).toBe("name");
    expect(firstInvalid(["token"], {})).toBeUndefined();
  });
});

describe("preventComposingSubmit", () => {
  function renderForm() {
    const onSubmit = vi.fn((event: { preventDefault: () => void }) => event.preventDefault());
    render(
      <form onKeyDown={preventComposingSubmit} onSubmit={onSubmit}>
        <input aria-label="Name" />
      </form>,
    );
    return screen.getByLabelText("Name");
  }

  it("blocks Enter while an input method is composing", () => {
    const input = renderForm();
    // fireEvent returns false when the event's default action was prevented.
    expect(fireEvent.keyDown(input, { key: "Enter", isComposing: true })).toBe(false);
  });

  it("blocks the Safari confirm keydown, which reports keyCode 229", () => {
    const input = renderForm();
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 229 })).toBe(false);
  });

  it("lets a normal Enter through", () => {
    const input = renderForm();
    expect(fireEvent.keyDown(input, { key: "Enter", keyCode: 13 })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "a", isComposing: true })).toBe(true);
  });
});

describe("safeRedirect", () => {
  it.each([
    ["/", "/"],
    ["/dashboards", "/dashboards"],
    ["/explore?q=a%20b#result", "/explore?q=a%20b#result"],
    // Normalized the way the browser would send it.
    ["/data-sources/ü", "/data-sources/%C3%BC"],
  ])("keeps %s", (path, expected) => {
    expect(safeRedirect(path)).toBe(expected);
  });

  it.each([
    "https://evil.example/",
    "//evil.example/",
    "/\\evil.example/",
    "\\\\evil.example",
    "/\tevil",
    // Dot segments that collapse into a protocol-relative URL after normalization.
    "/..//evil.example/x",
    "/.//evil.example",
    "/%2e%2e//evil.example",
    "/%2E%2E//evil.example",
    "/a/../..//evil.example",
    "javascript:alert(1)",
    "dashboards",
    "",
    "/login",
    "/login?redirect=/x",
    "/setup",
  ])("rejects %s", (value) => {
    expect(safeRedirect(value)).toBeUndefined();
  });

  it("rejects non-strings", () => {
    expect(safeRedirect(undefined)).toBeUndefined();
    expect(safeRedirect(["/x"])).toBeUndefined();
  });
});
