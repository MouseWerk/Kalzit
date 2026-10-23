/**
 * A stand-in for WebGL 2 and the 2D canvas in jsdom, enough for Sigma to construct, take a graph
 * and process it. Nothing is drawn: every call answers with a harmless value. Tests use it to run
 * the real renderer's bookkeeping (graph events, edge indexes), not its pictures.
 */

const constants = new Map<string, number>();
function constant(name: string): number {
  let value = constants.get(name);
  if (value === undefined) {
    value = 0x1000 + constants.size;
    constants.set(name, value);
  }
  return value;
}

const isConstant = (name: string | symbol): boolean =>
  typeof name === "string" && /^[A-Z][A-Z0-9_]*$/.test(name);

function webgl(canvas: HTMLCanvasElement): unknown {
  const answers: Record<string, (...args: unknown[]) => unknown> = {
    getParameter: () => 4096,
    // Extensions answer every method (loseContext, drawBuffersWEBGL, ...) with nothing.
    getExtension: () => new Proxy({}, { get: () => () => undefined }),
    getSupportedExtensions: () => [],
    getShaderParameter: () => true,
    getProgramParameter: () => true,
    getShaderInfoLog: () => "",
    getProgramInfoLog: () => "",
    checkFramebufferStatus: () => constant("FRAMEBUFFER_COMPLETE"),
    getAttribLocation: () => 0,
    getUniformLocation: () => ({}),
    getUniformBlockIndex: () => 0,
    getContextAttributes: () => ({}),
    isContextLost: () => false,
    getError: () => 0,
    fenceSync: () => ({}),
    clientWaitSync: () => constant("ALREADY_SIGNALED"),
    getSyncParameter: () => constant("SIGNALED"),
  };
  return new Proxy(
    {},
    {
      get(_, name) {
        if (isConstant(name)) return constant(name as string);
        if (name === "canvas") return canvas;
        if (name === "drawingBufferWidth" || name === "drawingBufferHeight") return 100;
        if (typeof name !== "string") return undefined;
        if (name in answers) return answers[name];
        return name.startsWith("create") ? () => ({}) : () => undefined;
      },
    },
  );
}

function context2d(canvas: HTMLCanvasElement): unknown {
  const state: Record<string, unknown> = { canvas, font: "10px sans-serif" };
  // Pixel data stays one pixel whatever size is asked: nothing reads real pictures here, and
  // the renderer's glyph atlas asks for large ones.
  const image = (w = 1, h = 1) => ({ width: w, height: h, data: new Uint8ClampedArray(4) });
  return new Proxy(state, {
    get(target, name) {
      if (typeof name !== "string") return undefined;
      if (name in target) return target[name];
      if (name === "measureText") {
        return (text: string) => ({
          width: text.length * 6,
          actualBoundingBoxAscent: 8,
          actualBoundingBoxDescent: 2,
          actualBoundingBoxLeft: 0,
          actualBoundingBoxRight: text.length * 6,
          fontBoundingBoxAscent: 8,
          fontBoundingBoxDescent: 2,
        });
      }
      if (name === "getImageData" || name === "createImageData") {
        return (_x?: number, _y?: number, w?: number, h?: number) => image(w, h);
      }
      return () => undefined;
    },
    set(target, name, value) {
      if (typeof name === "string") target[name] = value;
      return true;
    },
  });
}

/** Installs the stand-ins; returns a function that removes them. */
export function installWebGLStub(): () => void {
  const scope = globalThis as unknown as Record<string, unknown>;
  const hadWebGL = "WebGL2RenderingContext" in scope;
  const constants = () =>
    new Proxy(function WebGLContext() {}, {
      get(target, key) {
        return isConstant(key) ? constant(key as string) : Reflect.get(target, key);
      },
    });
  scope.WebGL2RenderingContext = constants();
  const hadWebGL1 = "WebGLRenderingContext" in scope;
  scope.WebGLRenderingContext = constants();
  const hadImageData = "ImageData" in scope;
  if (!hadImageData) {
    scope.ImageData = class ImageData {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(a: Uint8ClampedArray | number, b: number, c?: number) {
        this.data = typeof a === "number" ? new Uint8ClampedArray(a * b * 4) : a;
        this.width = typeof a === "number" ? a : b;
        this.height = typeof a === "number" ? b : (c ?? a.length / 4 / b);
      }
    };
  }
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function getContext(
    this: HTMLCanvasElement,
    kind: string,
  ) {
    if (kind === "webgl2") return webgl(this);
    if (kind === "2d") return context2d(this);
    return null;
  } as typeof original;
  return () => {
    HTMLCanvasElement.prototype.getContext = original;
    if (!hadWebGL) delete scope.WebGL2RenderingContext;
    if (!hadWebGL1) delete scope.WebGLRenderingContext;
    if (!hadImageData) delete scope.ImageData;
  };
}
