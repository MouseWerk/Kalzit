import { afterEach, describe, expect, it, vi } from "vitest";
import { LIGHT_ANIMATION, LIT_ATTRIBUTE, playSignInLight, registerPicture } from "./signInLight";

/** A picture on the page; jsdom lays nothing out, so the test says whether it is drawn. */
function picture(drawn = true): HTMLElement {
  const element = document.createElement("div");
  document.body.append(element);
  element.getClientRects = () => (drawn ? [new DOMRect(0, 0, 600, 800)] : []) as never;
  registerPicture(element);
  return element;
}

/** The person's settings: which media queries match. */
function media(matching: readonly string[]) {
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: matching.includes(query) }));
}

const MOTION = "(prefers-reduced-motion: no-preference)";
const FORCED = "(forced-colors: active)";

function end(element: HTMLElement, animationName: string) {
  const event = new Event("animationend", { bubbles: true });
  Object.assign(event, { animationName });
  element.dispatchEvent(event);
}

afterEach(() => {
  registerPicture(null);
  document.body.replaceChildren();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the light after a sign-in", () => {
  it("runs once over the picture and lets the app open when it is through", async () => {
    media([MOTION]);
    const element = picture();
    let through = false;
    const light = playSignInLight().then(() => {
      through = true;
    });
    expect(element.hasAttribute(LIT_ATTRIBUTE)).toBe(true);
    // Another animation inside the picture ending is not the light.
    end(element, "something-else");
    await Promise.resolve();
    expect(through).toBe(false);
    end(element, LIGHT_ANIMATION);
    await light;
    expect(through).toBe(true);
    expect(element.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
  });

  it("does not run for reduced motion", async () => {
    media([]);
    const element = picture();
    await playSignInLight();
    expect(element.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
  });

  it("does not run in forced colors, where the picture is not shown", async () => {
    media([MOTION, FORCED]);
    const element = picture();
    await playSignInLight();
    expect(element.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
  });

  it("does not wait where the picture is not drawn or not on the page", async () => {
    media([MOTION]);
    const hidden = picture(false);
    await playSignInLight();
    expect(hidden.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
    registerPicture(null);
    await playSignInLight();
    const gone = picture();
    gone.remove();
    await playSignInLight();
    expect(gone.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
  });

  it("never keeps anyone from the app: it gives up when the end is not told", async () => {
    vi.useFakeTimers();
    media([MOTION]);
    const element = picture();
    let through = false;
    void playSignInLight().then(() => {
      through = true;
    });
    await vi.advanceTimersByTimeAsync(899);
    expect(through).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(through).toBe(true);
    expect(element.hasAttribute(LIT_ATTRIBUTE)).toBe(false);
  });
});
