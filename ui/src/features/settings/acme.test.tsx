import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin, sent } from "../admin/test/openAdmin";
import { ACME_AT, acmeSettings } from "./test/fakeAcme";

function form() {
  return screen.findByRole("form", { name: "Automatic certificates (ACME)" });
}

describe("ACME certificates", () => {
  it("saves the dependent fields in one step and shows the server's problem at its field", async () => {
    const { user, server } = await openAdmin("/settings/network", { isServerAdmin: true });
    const card = await form();
    expect(within(card).getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true);

    await user.click(
      within(card).getByRole("switch", { name: "Order certificates automatically" }),
    );
    await user.type(within(card).getByRole("textbox", { name: "Names" }), "kalzit.example.com");
    await user.type(
      within(card).getByRole("textbox", { name: "Contact email" }),
      "ops@example.com",
    );
    expect(within(card).getByText("Unsaved changes")).toBeTruthy();
    // Nothing is sent before Save: the fields depend on each other.
    expect(sent(server, "PUT")).toEqual([]);

    server.areas.acme.saveAnswer = {
      status: 422,
      code: "validation",
      field: "acceptTerms",
      reason: "acme.terms_not_accepted",
    };
    await user.click(within(card).getByRole("button", { name: "Save" }));
    const terms = within(card).getByRole("checkbox", { name: "Accept the terms of service" });
    await waitFor(() => expect(terms.getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(card).getByText("Accept the terms of service of the certificate authority."),
    ).toBeTruthy();

    await user.click(terms);
    await user.click(within(card).getByRole("button", { name: "Save" }));
    await screen.findByText(
      "Certificate settings saved. Kalzit orders the certificate in the background.",
    );
    const body = server.calls.filter((c) => c.method === "PUT").at(-1)?.body as {
      settings: Record<string, unknown>;
      version: number;
    };
    expect(body.version).toBe(0);
    expect(body.settings).toMatchObject({
      enabled: true,
      directory: "letsencrypt",
      domains: ["kalzit.example.com"],
      email: "ops@example.com",
      challenge: "http-01",
      acceptTerms: true,
    });
    expect(await screen.findByText("Waiting for the order")).toBeTruthy();
  });

  it("tests the connection, links the terms and names the warnings", async () => {
    const { user, server } = await openAdmin("/settings/network", {
      isServerAdmin: true,
      setupServer: (s) => {
        s.areas.acme.testAnswer = {
          termsOfService: "https://ca.example/terms.pdf",
          warnings: [{ reason: "acme.http_port", params: { port: "3000" }, message: "port" }],
        };
      },
    });
    const card = await form();
    await user.click(within(card).getByRole("radio", { name: "Other" }));
    const address = within(card).getByRole("textbox", { name: "ACME address" });
    await user.type(address, "https://ca.internal.example/acme/directory");
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    expect(
      await within(card).findByText("The certificate authority answers and every name resolves."),
    ).toBeTruthy();
    expect(
      within(card).getByText(
        "The certificate authority connects to port 80, but HTTP listens on port 3000. Forward port 80 to it.",
      ),
    ).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Read the terms of service" }).getAttribute("href"),
    ).toBe("https://ca.example/terms.pdf");
    expect(sent(server, "POST")).toContain("/api/admin/acme/test");

    server.areas.acme.testAnswer = {
      status: 422,
      code: "validation",
      field: "directoryUrl",
      reason: "acme.directory_unreachable",
      params: { detail: "connection refused" },
    };
    await user.click(within(card).getByRole("button", { name: "Test connection" }));
    await waitFor(() => expect(address.getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(card).getByText("The certificate authority cannot be reached: connection refused"),
    ).toBeTruthy();
  });

  it("shows the certificate in use, its renewal and the last failure", async () => {
    const day = 86_400_000;
    const { user, server } = await openAdmin("/settings/network", {
      isServerAdmin: true,
      setupServer: (s) => {
        s.areas.acme.view = {
          ...s.areas.acme.view,
          settings: acmeSettings({
            enabled: true,
            domains: ["kalzit.example.com"],
            acceptTerms: true,
          }),
          version: 3,
          status: {
            phase: "failed",
            certificate: {
              domains: ["kalzit.example.com"],
              issuer: "R11",
              notBefore: ACME_AT,
              notAfter: ACME_AT + 90 * day,
              issuedAt: ACME_AT,
              directoryUrl: "https://acme-v02.api.letsencrypt.org/directory",
              renewAt: ACME_AT + 60 * day,
            },
            nextAttemptAt: ACME_AT + 2 * day,
            lastError: {
              reason: "acme.rate_limited",
              params: { detail: "too many certificates" },
              message: "rate limited",
              at: ACME_AT + day,
            },
            failures: 2,
            storeError: {
              reason: "acme.store_failed",
              params: { detail: "disk full" },
              message: "disk full",
              at: ACME_AT,
            },
          },
        };
      },
    });
    const status = await screen.findByRole("region", { name: "HTTPS certificate" });
    expect(within(status).getByText("The last attempt failed")).toBeTruthy();
    expect(within(status).getByText("R11")).toBeTruthy();
    expect(within(status).getByText(/rate limit was reached: too many certificates/)).toBeTruthy();
    expect(
      within(status).getByText(/Not stored yet, Kalzit tries again: .*disk full/),
    ).toBeTruthy();
    await user.click(within(status).getByRole("button", { name: "Renew now" }));
    expect(await within(status).findByText("Ordering the certificate…")).toBeTruthy();
    expect(sent(server, "POST")).toContain("/api/admin/acme/renew");
  });

  it("says why ACME cannot be used while certificate files are configured", async () => {
    await openAdmin("/settings/network", {
      isServerAdmin: true,
      setupServer: (s) => {
        s.areas.acme.view = {
          ...s.areas.acme.view,
          server: { httpAddr: "0.0.0.0:80", httpsAddr: "0.0.0.0:443", certificateFiles: true },
        };
      },
    });
    const card = await form();
    expect(
      within(card).getByText(/HTTPS uses the certificate files from kalzit.toml/),
    ).toBeTruthy();
  });
});
