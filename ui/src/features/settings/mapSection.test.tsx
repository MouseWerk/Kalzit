import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "../admin/test/openAdmin";
import type { FakeMapState } from "./test/fakeMap";

const SOURCE = {
  enabled: true,
  urlTemplate: "https://karten.example.org/tiles/{z}/{x}/{y}.png",
  attribution: "© Beispiel-Kartendienst und Mitwirkende",
  maxZoom: 14,
  cacheMaxMb: 2048,
  cacheTtlDays: 7,
};

const open = (setup?: (map: FakeMapState) => void) =>
  openAdmin("/settings/map", {
    isServerAdmin: true,
    setupServer: (server) => setup?.(server.areas.map),
  });

describe("Verwaltung > Karte", () => {
  it("is off after installation, with the bundled outlines and the reason", async () => {
    await open();
    const toggle = await screen.findByRole("switch", { name: "Map images" });
    expect(toggle).toHaveProperty("checked", false);
    expect(screen.getByText(/Off: maps show coordinates with outlines/)).toBeTruthy();
    expect(screen.getByText("built in")).toBeTruthy();
    expect(screen.getByText(/Map images come from a service outside your server/)).toBeTruthy();
    expect(screen.getByText("/api/map/tiles/{z}/{x}/{y}")).toBeTruthy();
    expect(screen.queryByRole("form", { name: "Map images" })).toBeNull();
  });

  it("switches on with a form, tests and saves once, and names the proxy", async () => {
    const { user, server } = await open();
    await user.click(await screen.findByRole("switch", { name: "Map images" }));
    const form = await screen.findByRole("form", { name: "Map images" });
    expect(within(form).getByText(/proxy\.intern\.example:3128/)).toBeTruthy();
    await user.type(
      within(form).getByRole("textbox", { name: "Address of the map images" }),
      SOURCE.urlTemplate.replaceAll("{", "{{"),
    );
    await user.type(within(form).getByRole("textbox", { name: "Attribution" }), SOURCE.attribution);
    await user.click(within(form).getByRole("button", { name: "Test map images" }));
    expect(
      await within(form).findByText(
        "Map image 6/33/21 loaded: 14 kB, image/png, 180 ms, through the proxy.",
      ),
    ).toBeTruthy();
    await user.click(within(form).getByRole("button", { name: "Save" }));
    expect(await screen.findByText("Map images are on.")).toBeTruthy();
    const map = server.areas.map;
    expect(map.saves).toEqual([
      {
        source: {
          urlTemplate: SOURCE.urlTemplate,
          attribution: SOURCE.attribution,
          maxZoom: 14,
          cacheMaxMb: 2048,
          cacheTtlDays: 7,
        },
        version: 0,
      },
    ]);
    expect(map.view.source?.enabled).toBe(true);
  });

  it("puts a refusal at its field, and a failed test without a field under the buttons", async () => {
    const { user, server } = await open((map) => {
      map.refuse = {
        status: 422,
        code: "validation",
        reason: "map.attribution_required",
        field: "attribution",
      };
    });
    await user.click(await screen.findByRole("switch", { name: "Map images" }));
    const form = await screen.findByRole("form", { name: "Map images" });
    await user.type(
      within(form).getByRole("textbox", { name: "Address of the map images" }),
      "https://karten.example.org/{{z}/{{x}/{{y}.png",
    );
    await user.click(within(form).getByRole("button", { name: "Save" }));
    const attribution = within(form).getByRole("textbox", { name: "Attribution" });
    await waitFor(() => expect(attribution.getAttribute("aria-invalid")).toBe("true"));
    expect(
      within(form).getByText("Without an attribution, Kalzit must not show the map images."),
    ).toBeTruthy();
    expect(within(form).getByText("Check the marked field. Nothing was saved.")).toBeTruthy();
    server.areas.map.refuse = {
      status: 422,
      code: "validation",
      reason: "map.source_denied",
      params: { status: "403" },
    };
    await user.type(attribution, "© Beispiel");
    await user.click(within(form).getByRole("button", { name: "Test map images" }));
    expect(
      await within(form).findByText(
        "Test failed: The source answered 403 (access denied). Check the access key. Nothing was saved.",
      ),
    ).toBeTruthy();
    expect(server.areas.map.view.source).toBeNull();
  });

  it("switches off at once with undo, and empties the cache", async () => {
    const { user, server } = await open((map) => {
      map.view = {
        ...map.view,
        source: SOURCE,
        version: 3,
        cache: { bytes: 2_097_152, tiles: 140 },
      };
    });
    expect(await screen.findByText("140 map images in the cache, 2 MB.")).toBeTruthy();
    await user.click(screen.getByRole("switch", { name: "Map images" }));
    expect(await screen.findByText("Map images are off. Maps show outlines.")).toBeTruthy();
    expect(server.areas.map.switches).toEqual([{ enabled: false, version: 3 }]);
    expect(screen.getByRole("switch", { name: "Map images" })).toHaveProperty("checked", false);
    await user.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(server.areas.map.switches).toEqual([
        { enabled: false, version: 3 },
        { enabled: true, version: 4 },
      ]),
    );
    await waitFor(() =>
      expect(screen.getByRole("switch", { name: "Map images" })).toHaveProperty("checked", true),
    );
  });

  it("is not offered to organization admins", async () => {
    await openAdmin("/settings/map", { isServerAdmin: false });
    expect(screen.queryByRole("switch", { name: "Map images" })).toBeNull();
  });
});
