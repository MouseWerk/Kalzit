import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { expectConsoleOutput } from "../test/console";
import { LazyPiece, pieceSource } from "./LazyPiece";

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

/** A loader whose first `failures` imports reject, as a chunk a deploy replaced does. */
function flaky(failures: number) {
  let left = failures;
  return vi.fn(async () => {
    if (left > 0) {
      left -= 1;
      throw new Error("chunk gone");
    }
    return { default: Hello };
  });
}

describe("LazyPiece", () => {
  it("draws the piece once it loaded", async () => {
    const source = pieceSource(flaky(0));
    render(<LazyPiece source={source} props={{ name: "Ada" }} pending={<p>Loading</p>} />);
    expect(screen.getByText("Loading")).toBeTruthy();
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
  });

  it("falls back alone when its chunk fails, and tells the page", async () => {
    const source = pieceSource(flaky(1));
    const onLoadError = vi.fn();
    render(
      <div>
        <p>The page</p>
        <LazyPiece source={source} props={{ name: "Ada" }} onLoadError={onLoadError} />
      </div>,
    );
    await vi.waitFor(() => expect(onLoadError).toHaveBeenCalledTimes(1));
    // The page around it stays; the piece shows nothing.
    expect(screen.getByText("The page")).toBeTruthy();
    expect(screen.queryByText(/Hello/)).toBeNull();
    expectConsoleOutput(/chunk gone/);
  });

  it("imports again on the next mount, instead of keeping the failure for good", async () => {
    const load = flaky(1);
    const source = pieceSource(load);
    // The import fails with nothing mounted to catch it: the dialog was closed while it loaded.
    await expect(source.load()).rejects.toThrow("chunk gone");
    // Opened again (the dialog, the badge of another page): a fresh import.
    render(<LazyPiece source={source} props={{ name: "Ada" }} />);
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("offers a retry in the piece's place", async () => {
    const source = pieceSource(flaky(1));
    const user = userEvent.setup();
    render(
      <LazyPiece
        source={source}
        props={{ name: "Ada" }}
        failed={(retry) => (
          <button type="button" onClick={retry}>
            Try again
          </button>
        )}
      />,
    );
    await user.click(await screen.findByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Hello Ada")).toBeTruthy();
    expectConsoleOutput(/chunk gone/);
  });
});
