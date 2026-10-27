import Sigma from "sigma";

/**
 * Sigma 4.0.3 draws node and edge labels a second time into its picking framebuffer, with a
 * fragment shader that only discards (labels are not pickable). Its output is never written, so
 * the GLSL compiler drops it, and Chromium refuses each of those draws with
 * "GL_INVALID_OPERATION: glDrawArraysInstanced: Active draw buffers with missing fragment shader
 * outputs". Nodes and edges are picked by their own programs, which do write the output, so
 * clicks work either way; but the refused draw is an error on every frame.
 *
 * The label programs' picking programs are therefore dropped right after Sigma builds them (at
 * construction and after a lost WebGL context), so their picking pass is skipped as it is for any
 * program without one. Sigma calls the private `initPrograms` for both; it is wrapped once, here.
 * To be reported upstream; remove this once Sigma skips the picking pass of label programs.
 */

interface ProgramInfo {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  buffer: WebGLBuffer | null;
  vertexShader: WebGLShader;
  fragmentShader: WebGLShader;
}

interface LabelProgram {
  pickProgram: ProgramInfo | null;
}

function hasPickProgram(value: unknown): value is LabelProgram {
  return typeof value === "object" && value !== null && "pickProgram" in value;
}

/** Says so in development when Sigma no longer looks as this fix expects (an upgrade). */
function notice(what: string): void {
  if (import.meta.env.DEV && import.meta.env.MODE !== "test") {
    // biome-ignore lint/suspicious/noConsole: a note for developers only, never in a build
    console.warn(`labelPicking: ${what}; the fix does nothing, check it against this Sigma`);
  }
}

/** Deletes a program's picking program and leaves it without one. */
export function dropPicking(program: unknown): void {
  if (!hasPickProgram(program)) {
    notice("a label program has no pickProgram");
    return;
  }
  if (program.pickProgram === null) return;
  const { gl, program: glProgram, buffer, vertexShader, fragmentShader } = program.pickProgram;
  gl.deleteShader(vertexShader);
  gl.deleteShader(fragmentShader);
  gl.deleteProgram(glProgram);
  gl.deleteBuffer(buffer);
  program.pickProgram = null;
}

type InitPrograms = (...args: unknown[]) => Record<string, unknown>;

let installed = false;

/** Wraps Sigma's program setup once, so every renderer draws labels without a picking pass. */
export function installLabelPickingFix(): void {
  if (installed) return;
  installed = true;
  const prototype = Sigma.prototype as unknown as { initPrograms?: InitPrograms };
  const original = prototype.initPrograms;
  if (typeof original !== "function") {
    notice("Sigma has no initPrograms");
    return;
  }
  prototype.initPrograms = function initPrograms(this: unknown, ...args: unknown[]) {
    const programs = original.apply(this, args);
    dropPicking(programs.labelProgram);
    dropPicking(programs.edgeLabelProgram);
    return programs;
  };
}
