import { screen, waitFor, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { FakeServer } from "../../../test/fakeServer";
import { openAdmin } from "../test/openAdmin";
import { SAMPLE_CERT, sampleProvider, sampleSamlProvider } from "./test/fakeSso";

async function openSignIn(arrange: (server: FakeServer) => void = () => {}) {
  const opened = await openAdmin("/settings/signin", { isServerAdmin: true, setupServer: arrange });
  await screen.findByRole("heading", { level: 2, name: "Sign-in" });
  return opened;
}

async function openNewSaml(user: UserEvent) {
  await user.click(await screen.findByRole("button", { name: "Add provider…" }));
  const chooser = await screen.findByRole("dialog", { name: "Add provider" });
  await user.click(within(chooser).getByRole("radio", { name: /^SAML 2\.0/ }));
  await user.click(within(chooser).getByRole("button", { name: "Continue" }));
  return screen.findByRole("dialog", { name: "Add SAML 2.0" });
}

function saveButton(dialog: HTMLElement) {
  return within(dialog).getByRole("button", { name: "Save" });
}

function describedTexts(element: HTMLElement): string[] {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "");
}

describe("sign-in administration, SAML provider", () => {
  it("lists a SAML provider with its entity ID and a place among the buttons", async () => {
    await openSignIn((server) => {
      server.areas.sso.providers = [sampleProvider(), sampleSamlProvider({ position: 1 })];
    });
    const table = await screen.findByRole("table");
    const row = within(table).getByText("Partnerportal").closest("tr") as HTMLElement;
    expect(within(row).getByText("SAML 2.0")).toBeTruthy();
    expect(within(row).getByText("SA")).toBeTruthy();
    expect(within(row).getByText("https://idp.partnerportal.example/saml")).toBeTruthy();
    expect(within(row).getByText("Button 2")).toBeTruthy();
  });

  it("reads the metadata, pins its values and saves with the check's token", async () => {
    const { user, server } = await openSignIn();
    const dialog = await openNewSaml(user);
    await user.type(within(dialog).getByLabelText("Name on the button"), "Partnerportal");
    expect(within(dialog).getByLabelText("Kalzit’s entity ID")).toHaveProperty(
      "value",
      "https://kalzit.example/auth/saml/partnerportal",
    );
    expect(within(dialog).getByLabelText("ACS URL")).toHaveProperty(
      "value",
      "https://kalzit.example/auth/saml/partnerportal/acs",
    );
    // Signed answers are always required.
    const signed = within(dialog).getByRole("switch", { name: "Require signed answers" });
    expect(signed).toHaveProperty("checked", true);
    expect(signed).toHaveProperty("disabled", true);
    // The second factor stays with Kalzit unless switched.
    expect(within(dialog).getByRole("switch", { name: "Second factor after SSO" })).toHaveProperty(
      "checked",
      false,
    );

    await user.type(
      within(dialog).getByLabelText("Provider metadata URL"),
      "https://idp.partnerportal.example/saml/metadata.xml",
    );
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("true");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    expect(
      await within(dialog).findByText(/^Check ok\. Pinned for https:\/\/idp\.partnerportal/),
    ).toBeTruthy();
    expect(within(dialog).getByText("AB:CD:00")).toBeTruthy();
    expect(within(dialog).getByLabelText("Provider entity ID")).toHaveProperty(
      "value",
      "https://idp.partnerportal.example/saml",
    );
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");

    await user.click(saveButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = server.areas.sso.samlSaved[0] as Record<string, unknown>;
    expect(saved.checkToken).toMatch(/^saml-token-/);
    expect(saved.trustProviderMfa).toBe(false);
    const saml = saved.saml as Record<string, unknown>;
    expect(saml.certificates).toEqual([SAMPLE_CERT]);
    expect(saml.ssoUrl).toBe("https://idp.partnerportal.example/saml/sso");
    expect(saml).not.toHaveProperty("metadataXml");
    expect(server.areas.sso.providers.map((provider) => provider.kind)).toEqual(["saml"]);
  });

  it("sends an uploaded metadata file with the check", async () => {
    const { user, server } = await openSignIn();
    const dialog = await openNewSaml(user);
    await user.type(within(dialog).getByLabelText("Name on the button"), "Partnerportal");
    const file = new File(["<md:EntityDescriptor/>"], "partnerportal.xml", { type: "text/xml" });
    const input = dialog.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, file);
    expect(
      await within(dialog).findByText("The file partnerportal.xml is read on the next check."),
    ).toBeTruthy();
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    await within(dialog).findByText(/^Check ok\./);
    const sent = (server.areas.sso.checksSent[0] as Record<string, unknown>).saml as Record<
      string,
      unknown
    >;
    expect(sent.metadataXml).toBe("<md:EntityDescriptor/>");
  });

  it("shows an unreachable metadata URL at its field with the message on top", async () => {
    const { user, server } = await openSignIn();
    server.areas.sso.checkRefusal = {
      field: "metadataUrl",
      reason: "saml.metadata_unreachable",
      params: { detail: "HTTP 404" },
    };
    const dialog = await openNewSaml(user);
    await user.type(within(dialog).getByLabelText("Name on the button"), "Partnerportal");
    await user.type(
      within(dialog).getByLabelText("Provider metadata URL"),
      "https://idp.partnerportal.example/saml/metadata.xml",
    );
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    const url = within(dialog).getByLabelText("Provider metadata URL");
    await waitFor(() => expect(url.getAttribute("aria-invalid")).toBe("true"));
    expect(document.activeElement).toBe(url);
    expect(describedTexts(url)).toContain(
      "The metadata cannot be reached: HTTP 404. Check the address with the provider or upload the metadata as a file.",
    );
    expect(within(dialog).getAllByRole("alert")[0]?.textContent).toMatch(/^Check failed\./);
  });

  it("asks for the provider's values without metadata, before any request", async () => {
    const { user, server } = await openSignIn();
    const dialog = await openNewSaml(user);
    await user.type(within(dialog).getByLabelText("Name on the button"), "Partnerportal");
    await user.click(within(dialog).getByRole("button", { name: "Check connection" }));
    const entity = await within(dialog).findByLabelText("Provider entity ID");
    await waitFor(() => expect(entity.getAttribute("aria-invalid")).toBe("true"));
    expect(server.areas.sso.checksSent).toHaveLength(0);
  });

  it("warns when the public address is missing", async () => {
    const { user } = await openSignIn((server) => {
      server.areas.sso.samlBase = null;
    });
    const dialog = await openNewSaml(user);
    expect(within(dialog).getByText(/^The public address is missing\./)).toBeTruthy();
    expect(within(dialog).getByLabelText("ACS URL")).toHaveProperty(
      "value",
      "Public address missing",
    );
  });

  it("edits a stored provider without a new check while its trust is unchanged", async () => {
    const { user, server } = await openSignIn((server) => {
      server.areas.sso.providers = [sampleSamlProvider()];
    });
    await user.click(await screen.findByRole("button", { name: "Edit Partnerportal" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit Partnerportal" });
    expect(within(dialog).getByRole("link", { name: "SP metadata" }).getAttribute("href")).toBe(
      "https://kalzit.example/auth/saml/partnerportal/metadata",
    );
    expect(within(dialog).getByText("AB:CD:EF")).toBeTruthy();
    await user.click(within(dialog).getByRole("switch", { name: "Second factor after SSO" }));
    expect(saveButton(dialog).getAttribute("aria-disabled")).toBe("false");
    await user.click(saveButton(dialog));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const saved = server.areas.sso.samlSaved[0] as Record<string, unknown>;
    expect(saved).not.toHaveProperty("checkToken");
    expect(saved.trustProviderMfa).toBe(true);
  });
});
