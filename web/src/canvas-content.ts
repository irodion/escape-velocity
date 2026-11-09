import type { Viewport } from './viewport.js'

/**
 * What the fractal canvas's buffer holds right now: which rendered frame's
 * pixels, and where in the buffer they sit (#172).
 *
 * Two modules write those pixels. The render client paints a frame
 * (`putImageData`: a fresh render, or a recolorize of the cached one), and the
 * InputController redraws its drag snapshot (a pan's blit at the drag offset,
 * or the snapshot put back when a pinch takes over the pan). Each records what
 * it drew here, at the moment it draws it, so the record can't fall out of step
 * with the pixels however the two interleave. The cursor mappings (hover, pin,
 * Alt-click, the inspector's probe) read only this, to name the rendered sample
 * under the cursor (`cssToComplex`).
 *
 * The same shape as the gesture-phase store: `main.ts` creates it up front and
 * hands it to its writers and readers.
 */

/** A shift of the canvas buffer's contents, in buffer pixels. */
export interface BufferShift {
  readonly dx: number
  readonly dy: number
}

/** No shift: a frame where it was painted. */
export const NO_SHIFT: BufferShift = { dx: 0, dy: 0 }

/**
 * A rendered frame as the canvas buffer holds it. `rendered` is the viewport
 * the worker rendered it from: the buffer's own size, at the zoom times the
 * effective render scale (the render request's fields). `shift` is how far a
 * pan's blit has moved it within the buffer.
 */
export interface CanvasFrame {
  readonly rendered: Viewport
  readonly shift: BufferShift
}

export interface CanvasContentStore {
  /** The frame in the buffer, or null while it holds none (before the first paint). */
  get(): CanvasFrame | null
  /** Record what was just drawn into the buffer. */
  set(content: CanvasFrame | null): void
}

export function createCanvasContentStore(): CanvasContentStore {
  let content: CanvasFrame | null = null
  return {
    get: () => content,
    set: (next) => {
      content = next
    },
  }
}
