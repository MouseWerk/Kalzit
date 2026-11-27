import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SIGN_IN_PICTURE_KEY } from "../appearance/api";
import { expectConsoleOutput } from "../test/console";
import { installFakeServer, TEST_PASSWORD, TEST_USER } from "../test/fakeServer";
import { renderApp } from "../test/renderApp";

type Server = ReturnType<typeof installFakeServer>;

function signInSettings(server: Server, values: Record<string, unknown>) {
  server.state.branding = {
    ...server.state.branding,
    signIn: { ...(server.state.branding.signIn as Record<string, unknown>), ...values },
  };
}

const picture = () => document.querySelector(".access__panel .access-bd");
const answered = (server: Server) =>
  waitFor(() => expect(server.calls.some((c) => c.path === "/api/branding")).toBe(true));

describe("the picture next to the sign-in form", () => {
  it("shows the crystal with table, document and graph, hidden from screen readers", async () => {
    const server = installFakeServer();
    renderApp("/login");
    await screen.findByRole("form", { name: "Sign in" });
    await waitFor(() => expect(picture()).toBeTruthy());
    await answered(server);
    const drawn = picture() as HTMLElement;
    expect(drawn.getAttribute("aria-hidden")).toBe("true");
    expect(drawn.className).toBe("access-bd");
    // Behind the crystal in three steps of distance, inside it clear and once more beside.
    expect(drawn.querySelectorAll(".access-art__behind")).toHaveLength(3);
    expect(drawn.querySelector(".access-art__echo")?.getAttribute("transform")).toBe(
      "translate(11 7)",
    );
    const clip = drawn.querySelector("clipPath");
    expect(clip?.id).toMatch(/^access-art-[\w-]+$/);
    expect(
      drawn.querySelector(".access-art__clear")?.parentElement?.getAttribute("clip-path"),
    ).toBe(`url(#${clip?.id})`);
    // No image file, no text, nothing a keyboard could reach.
    expect(drawn.querySelector("image, img, text, a, button, [tabindex]")).toBeNull();
    expect(drawn.querySelectorAll(".access-art__light")).toHaveLength(2);
  });

  it("is gone where the server turned it off; the panel keeps its line on the product", async () => {
    const server = installFakeServer();
    signInSettings(server, { backdrop: false });
    renderApp("/login");
    expect(
      await screen.findByText("Tables, documents and graphs, each in its own shape."),
    ).toBeTruthy();
    expect(picture()).toBeNull();
    expect(document.querySelector(".access__panel")).toBeTruthy();
    // Noted for the first paint of the next visit.
    expect(window.localStorage.getItem(SIGN_IN_PICTURE_KEY)).toBe("off");
  });

  it("does not flash on the next visit to a server that turned it off", async () => {
    const server = installFakeServer();
    signInSettings(server, { backdrop: false });
    window.localStorage.setItem(SIGN_IN_PICTURE_KEY, "off");
    renderApp("/login");
    // From the first frame on, before and after the server's answer.
    expect(picture()).toBeNull();
    await screen.findByRole("form", { name: "Sign in" });
    await answered(server);
    expect(picture()).toBeNull();
  });

  it("is there from the first frame on a server known to show it", async () => {
    installFakeServer();
    window.localStorage.setItem(SIGN_IN_PICTURE_KEY, "on");
    renderApp("/login");
    await waitFor(() => expect(document.querySelector(".access__panel")).toBeTruthy());
    expect(picture()).toBeTruthy();
  });

  it("follows the server when the note is out of date", async () => {
    const server = installFakeServer();
    window.localStorage.setItem(SIGN_IN_PICTURE_KEY, "off");
    renderApp("/login");
    await screen.findByRole("form", { name: "Sign in" });
    await waitFor(() => expect(picture()).toBeTruthy());
    await answered(server);
    expect(window.localStorage.getItem(SIGN_IN_PICTURE_KEY)).toBe("on");
  });

  it("stands quieter on a server with its own product name", async () => {
    const server = installFakeServer();
    server.state.branding = { ...server.state.branding, productName: "Sunstone Insights" };
    renderApp("/login");
    await screen.findByRole("form", { name: "Sign in" });
    await waitFor(() => expect(picture()?.className).toBe("access-bd access-bd--quiet"));
  });

  it("stays in the frame of an unknown address", async () => {
    installFakeServer();
    renderApp("/no-such-page");
    expect(await screen.findByRole("heading", { level: 1, name: "Page not found" })).toBeTruthy();
    await waitFor(() => expect(picture()).toBeTruthy());
  });

  it("frames the error page while the server is down, with the way to try again", async () => {
    const server = installFakeServer();
    server.state.offline = true;
    expectConsoleOutput(/Failed to fetch/, /Error in route match/);
    const { user } = renderApp("/login");
    const heading = await screen.findByRole("heading", { level: 1, name: "Kalzit could not load" });
    expect(heading.closest('[role="alert"]')).toBeTruthy();
    expect(heading.closest(".access__column")).toBeTruthy();
    expect(
      screen.getByText("The server cannot be reached. Check that it is running, then try again."),
    ).toBeTruthy();
    // Language, theme and help stay; the server said nothing about the picture, so it shows.
    expect(screen.getByRole("link", { name: "Help" })).toBeTruthy();
    await waitFor(() => expect(picture()).toBeTruthy());
    server.state.offline = false;
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("form", { name: "Sign in" })).toBeTruthy();
  });

  it("keeps the picture off on the error page of a server known to have turned it off", async () => {
    const server = installFakeServer();
    server.state.offline = true;
    expectConsoleOutput(/Failed to fetch/, /Error in route match/);
    window.localStorage.setItem(SIGN_IN_PICTURE_KEY, "off");
    renderApp("/login");
    await screen.findByRole("heading", { level: 1, name: "Kalzit could not load" });
    expect(picture()).toBeNull();
  });

  it("opens the app after a sign-in without waiting where nothing may move", async () => {
    // jsdom lays nothing out and knows no media queries: the light does not run.
    installFakeServer();
    const { user } = renderApp("/login");
    await user.click(await screen.findByLabelText("Email address"));
    await user.paste(TEST_USER.email);
    await user.click(screen.getByLabelText("Password"));
    await user.paste(TEST_PASSWORD);
    await user.click(screen.getByRole("button", { name: "Sign in" }));
    await waitFor(() => expect(document.querySelector(".access")).toBeNull());
  });
});
