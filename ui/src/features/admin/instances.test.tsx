import { screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { openAdmin } from "./test/openAdmin";

describe("instances", () => {
  it("lists the servers on the database with the leader and this server", async () => {
    await openAdmin("/admin/server/instances", { isServerAdmin: true });
    const table = await screen.findByRole("table");
    const rows = within(table).getAllByRole("row");
    // The header and three servers.
    expect(rows).toHaveLength(4);
    const first = rows[1] as HTMLElement;
    expect(within(first).getByText("kalzit-a")).toBeTruthy();
    expect(within(first).getByText("Leader")).toBeTruthy();
    expect(within(first).getByText("This server")).toBeTruthy();
    expect(within(rows[3] as HTMLElement).getByText("Stopped")).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Summary" });
    expect(within(summary).getByText("Several servers")).toBeTruthy();
    expect(within(summary).getByText("At once (NOTIFY)")).toBeTruthy();
    // Two versions run at once: the page says to finish the update.
    expect(screen.getByText(/run different versions \(0\.5\.0, 0\.4\.1\)/)).toBeTruthy();
  });

  it("says that SQLite serves one server", async () => {
    await openAdmin("/admin/server/instances", {
      isServerAdmin: true,
      setup: (admin) => {
        const self = admin.instances.instances[0];
        admin.instances = {
          ...admin.instances,
          mode: "single",
          database: "sqlite",
          transport: "none",
          instances: self === undefined ? [] : [self],
        };
      },
    });
    expect(await screen.findByText(/SQLite serves one Kalzit server/)).toBeTruthy();
    expect(screen.getByText("One server")).toBeTruthy();
  });

  it("is only for server administrators", async () => {
    await openAdmin("/admin/server/instances", { isServerAdmin: false });
    expect(await screen.findByText(/No access|not open/i)).toBeTruthy();
  });
});
