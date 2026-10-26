import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { installFakeLive } from "../../test/fakeLive";
import { installFakeServer, TEST_USER } from "../../test/fakeServer";
import { renderApp } from "../../test/renderApp";
import { PG_ID } from "../datasources/test/fakeDatasources";

/** Explore's live toggle: the submitted query as a free live subscription, its result and reasons. */

let live: ReturnType<typeof installFakeLive>;

afterEach(() => {
  live.reset();
});

async function runSql(sql: string) {
  live = installFakeLive();
  installFakeServer({
    signedIn: true,
    user: { ...TEST_USER, isServerAdmin: false, orgs: [{ id: "o1", name: "Org", role: "editor" }] },
  });
  const app = renderApp("/explore");
  const editor = await screen.findByRole("textbox", { name: "Query" });
  fireEvent.change(editor, { target: { value: sql } });
  await app.user.click(screen.getByRole("button", { name: "Run query" }));
  expect(await screen.findByText("Grace")).toBeTruthy();
  return app;
}

describe("Explore live", () => {
  it("follows the query run, shows pushed results and ends when turned off", async () => {
    const { user } = await runSql("SELECT * FROM customers");
    const toggle = screen.getByRole("button", { name: "Live" });
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    await user.click(toggle);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    const socket = live.last();
    act(() => socket.open());
    const [subscribe] = socket.subscribes();
    expect(subscribe).toMatchObject({
      queries: [{ refId: "A", datasourceId: PG_ID, query: { sql: "SELECT * FROM customers" } }],
      lastMs: 3_600_000,
      variables: {},
    });
    const id = String(subscribe?.id);
    act(() => {
      socket.receive({ type: "subscribed", id, feed: "f1" });
      socket.receive({
        type: "status",
        feed: "f1",
        mode: "poll",
        refreshMs: 30_000,
        reason: "live.source_unsupported",
      });
      socket.receive({
        type: "result",
        feed: "f1",
        at: Date.now(),
        results: {
          A: {
            result: {
              shape: "frame",
              frame: { fields: [{ name: "name", type: "string", values: ["Lamarr"] }] },
            },
          },
        },
      });
    });
    expect(await screen.findByText("Lamarr")).toBeTruthy();
    expect(screen.queryByText("Grace")).toBeNull();
    expect(
      screen.getByText(/^Live, every 30s: The queries run again every 30s\. This source cannot/),
    ).toBeTruthy();

    await user.click(toggle);
    expect(socket.sent.at(-1)).toEqual({ type: "unsubscribe", id });
    expect(screen.queryByText(/^Live, every 30s/)).toBeNull();
  });

  it("shows the server's reason when it refuses the live query", async () => {
    const { user } = await runSql("SELECT * FROM customers");
    await user.click(screen.getByRole("button", { name: "Live" }));
    await waitFor(() => expect(live.sockets).toHaveLength(1));
    const socket = live.last();
    act(() => socket.open());
    const id = String(socket.subscribes()[0]?.id);
    act(() =>
      socket.receive({
        type: "error",
        id,
        error: { code: "forbidden", message: "no", reason: "live.forbidden" },
      }),
    );
    expect(
      await screen.findByText(
        "Live stopped: You no longer have access to this data, so its live updates stopped.",
      ),
    ).toBeTruthy();
  });
});
