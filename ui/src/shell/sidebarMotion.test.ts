import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SIDEBAR_MOTION_ATTRIBUTE, withSidebarMotion } from "./sidebarMotion";

/**
 * A stand-in for the browser's view transitions, as far as the slide relies on them: the update
 * runs in a later task; a transition started while another one runs skips the older one, whose
 * `ready` rejects with an AbortError while its update still applies and `finished` fulfills.
 */
function stubViewTransitions(): void {
  let running: { skip: () => void } | null = null;
  const start = (update?: ViewTransitionUpdateCallback): ViewTransition => {
    running?.skip();
    let skipReady: (error: DOMException) => void = () => {};
    let resolveReady: () => void = () => {};
    const ready = new Promise<undefined>((resolve, reject) => {
      resolveReady = () => resolve(undefined);
      skipReady = reject;
    });
    const updateCallbackDone = new Promise<undefined>((resolve, reject) => {
      setTimeout(() => {
        try {
          update?.();
          resolve(undefined);
        } catch (error) {
          reject(error);
        }
      });
    });
    const finished = updateCallbackDone.then(
      () => new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined))),
    );
    const own = {
      skip: () => skipReady(new DOMException("Transition was skipped", "AbortError")),
    };
    running = own;
    void updateCallbackDone.then(
      () =>
        setTimeout(() => {
          if (running === own) {
            resolveReady();
          }
        }),
      () => {},
    );
    void finished.then(() => {
      if (running === own) {
        running = null;
      }
    });
    return {
      ready,
      updateCallbackDone,
      finished,
      skipTransition: own.skip,
      types: new Set<string>() as unknown as ViewTransitionTypeSet,
    } as ViewTransition;
  };
  Object.defineProperty(document, "startViewTransition", {
    configurable: true,
    value: start,
  });
}

function settle(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 20));
}

describe("the sidebar's slide", () => {
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown) => rejections.push(reason);

  beforeEach(() => {
    rejections.length = 0;
    process.on("unhandledRejection", onRejection);
    stubViewTransitions();
  });

  afterEach(() => {
    process.off("unhandledRejection", onRejection);
    Reflect.deleteProperty(document, "startViewTransition");
    document.documentElement.removeAttribute(SIDEBAR_MOTION_ATTRIBUTE);
  });

  it("takes a second toggle before the first slide ends without an unhandled rejection", async () => {
    const applied: string[] = [];
    withSidebarMotion(() => applied.push("collapsed"));
    withSidebarMotion(() => applied.push("expanded"));
    expect(document.documentElement.hasAttribute(SIDEBAR_MOTION_ATTRIBUTE)).toBe(true);
    await settle();
    expect(applied).toEqual(["collapsed", "expanded"]);
    expect(rejections).toEqual([]);
    // Only the latest slide clears the attribute, once it has ended.
    expect(document.documentElement.hasAttribute(SIDEBAR_MOTION_ATTRIBUTE)).toBe(false);
  });

  it("clears the attribute after a single slide", async () => {
    let collapsed = false;
    withSidebarMotion(() => {
      collapsed = true;
    });
    await settle();
    expect(collapsed).toBe(true);
    expect(rejections).toEqual([]);
    expect(document.documentElement.hasAttribute(SIDEBAR_MOTION_ATTRIBUTE)).toBe(false);
  });
});
