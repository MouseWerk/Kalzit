import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { lazy, useEffect } from "react";
import { describe, expect, it, vi } from "vitest";
import { PanelErrorBoundary } from "../panels/PanelErrorBoundary";
import { expectConsoleOutput } from "../test/console";
import { LazyPiece, PieceLoadError, pieceSource } from "./LazyPiece";

function Hello({ name }: { name: string }) {
  return <p>Hello {name}</p>;
}

/** A piece that loads and then fails to draw. */
function Broken(): never {
  throw new Error("bug in the piece");
}

let mounts = 0;

/** Counts how often it was mounted. */
function Counted() {
  useEffect(() => {
    mounts += 1;
  }, []);
  return <p>Counted</p>;
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
    expectConsoleOutput(/could not be imported/);
  });

  it("imports again on the next mount, instead of keeping the failure for good", async () => {
    const load = flaky(1);
    const source = pieceSource(load);
    // The import fails with nothing mounted to catch it: the dialog was closed while it loaded.
    await expect(source.load()).rejects.toBeInstanceOf(PieceLoadError);
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
    expectConsoleOutput(/could not be imported/);
  });

  it("leaves a piece that crashes while drawing to the page, not to the connection message", async () => {
    const source = pieceSource<Record<never, never>>(async () => ({ default: Broken }));
    const onLoadError = vi.fn();
    render(
      <PanelErrorBoundary resetKeys={[]}>
        <LazyPiece
          source={source}
          props={{}}
          onLoadError={onLoadError}
          failed={() => <p>Check the connection</p>}
        />
      </PanelErrorBoundary>,
    );
    // The page's own boundary has it; the piece neither says "connection" nor tells its caller.
    await vi.waitFor(() => expect(screen.getByRole("alert")).toBeTruthy());
    expect(screen.queryByText("Check the connection")).toBeNull();
    expect(onLoadError).not.toHaveBeenCalled();
    expectConsoleOutput(/bug in the piece/);
  });

  it("keeps a drawn piece mounted when the source takes a fresh import for others", async () => {
    mounts = 0;
    const source = pieceSource<Record<never, never>>(async () => ({ default: Counted }));
    const view = render(<LazyPiece source={source} props={{}} />);
    await screen.findByText("Counted");
    expect(mounts).toBe(1);
    // Another mount of the same source failed and the source started over, as a failure does.
    source.current = lazy(source.load);
    view.rerender(<LazyPiece source={source} props={{}} />);
    await screen.findByText("Counted");
    expect(mounts).toBe(1);
  });

  it("marks a failed import as such, with what the import threw", async () => {
    const source = pieceSource(flaky(1));
    const failure = await source.load().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(PieceLoadError);
    expect((failure as PieceLoadError).cause).toEqual(new Error("chunk gone"));
  });
});
