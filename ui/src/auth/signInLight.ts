/**
 * The one movement of the picture in the panel (board Auth.dc.html, frame 14, "Bewegung"): when
 * a sign-in succeeds, a light runs once over the crystal's edges, then the app opens. Nothing
 * moves when the page loads, and nothing at all for reduced motion, in forced colors or where
 * the picture is not shown (narrow screens, the switch `signin.backdrop`, the contrast theme).
 */

/** The attribute on the picture while the light runs; auth.css starts the animation by it. */
export const LIT_ATTRIBUTE = "data-lit";
/** The animation whose end says the light is through (auth.css). */
export const LIGHT_ANIMATION = "access-art-light";
/** The longest the app waits for the light, should the animation's end never be told. */
const LIGHT_TIMEOUT_MS = 900;

let picture: HTMLElement | null = null;

/**
 * The picture on the page; Backdrop passes this as its ref. What it returns takes the picture
 * off again when it leaves, and only that one: with two layouts on a page for a moment (one
 * leaving, one arriving), the one that leaves must not take the other's picture with it.
 */
export function registerPicture(element: HTMLElement | null): () => void {
  if (element !== null) {
    picture = element;
  }
  return () => {
    if (picture === element) {
      picture = null;
    }
  };
}

/** Forgets the picture, whichever it is (tests). */
export function forgetPicture(): void {
  picture = null;
}

function matches(query: string): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia(query).matches;
}

/** Whether the light may run: a picture that is drawn, and a person who has not asked for rest. */
function mayRun(element: HTMLElement | null): element is HTMLElement {
  return (
    element?.isConnected === true &&
    element.getClientRects().length > 0 &&
    matches("(prefers-reduced-motion: no-preference)") &&
    !matches("(forced-colors: active)")
  );
}

/**
 * Lets the light run over the crystal's edges once and resolves when it is through; at once
 * where it may not run. It never rejects: the picture must not stand between a person and the
 * app.
 */
export function playSignInLight(): Promise<void> {
  const element = picture;
  if (!mayRun(element)) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      window.clearTimeout(timer);
      element.removeEventListener("animationend", ended);
      element.removeAttribute(LIT_ATTRIBUTE);
      resolve();
    };
    const ended = (event: AnimationEvent) => {
      if (event.animationName === LIGHT_ANIMATION) {
        done();
      }
    };
    const timer = window.setTimeout(done, LIGHT_TIMEOUT_MS);
    element.addEventListener("animationend", ended);
    element.setAttribute(LIT_ATTRIBUTE, "");
  });
}
