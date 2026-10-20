import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { safeRedirect } from "./redirect";
import {
  characterCount,
  firstInvalid,
  MIN_PASSWORD_LENGTH,
  preventComposingSubmit,
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

describe("validateSetup", () => {
  it("accepts a complete form", () => {
    expect(validateSetup(VALID_SETUP)).toEqual({});
  });

  it("reports every missing field, treating whitespace as empty", () => {
    expect(
      validateSetup({ token: " ", orgName: "\t", name: "", email: "  ", password: "" }),
    ).toEqual({
      token: "validation.tokenRequired",
      orgName: "validation.orgNameRequired",
      name: "validation.nameRequired",
      email: "validation.emailRequired",
      password: "validation.passwordRequired",
    });
  });

  it("needs at least 12 characters for the password", () => {
    expect(validateSetup({ ...VALID_SETUP, password: "a".repeat(11) }).password).toBe(
      "validation.passwordTooShort",
    );
    expect(validateSetup({ ...VALID_SETUP, password: "a".repeat(12) }).password).toBeUndefined();
  });

  it("counts characters, not UTF-16 units", () => {
    // U+1D538 is one character but two UTF-16 units; eleven of them are still too short.
    const elevenWide = "\u{1D538}".repeat(11);
    expect(elevenWide.length).toBe(22);
    expect(characterCount(elevenWide)).toBe(11);
    expect(validateSetup({ ...VALID_SETUP, password: elevenWide }).password).toBe(
      "validation.passwordTooShort",
    );
    expect(validateSetup({ ...VALID_SETUP, password: "Passwörter-äö" }).password).toBeUndefined();
  });

  it("does not trim the password, since spaces are part of it", () => {
    expect(validateSetup({ ...VALID_SETUP, password: " ".repeat(12) }).password).toBeUndefined();
  });

  it.each(["no-at-sign", "two@@example.com", "spa ce@example.com", "@example.com", "ada@"])(
    "rejects the email address %s",
    (email) => {
      expect(validateSetup({ ...VALID_SETUP, email }).email).toBe("validation.emailInvalid");
    },
  );

  it.each(["ada@example.com", "a+tag@sub.example.co.uk", "zoë@exämple.de", " ada@example.com "])(
    "accepts the email address %s",
    (email) => {
      expect(validateSetup({ ...VALID_SETUP, email }).email).toBeUndefined();
    },
  );
});

describe("validateLogin", () => {
  it("has no length rule for an existing password", () => {
    expect(validateLogin({ email: "ada@example.com", password: "short" })).toEqual({});
  });

  it("requires both fields", () => {
    expect(validateLogin({ email: "", password: "" })).toEqual({
      email: "validation.emailRequired",
      password: "validation.passwordRequired",
    });
  });
});

describe("firstInvalid", () => {
  it("follows the order of the form, not of the error object", () => {
    expect(
      firstInvalid(["token", "name", "password"], {
        password: "validation.passwordRequired",
        name: "validation.nameRequired",
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
