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
 * A rectangle of the rendered frame's own pixels, `[x0, x1) × [y0, y1)` in
 * its buffer coordinates.
 */
export interface FrameRegion {
  readonly x0: number
  readonly y0: number
  readonly x1: number
  readonly y1: number
}

/**
 * A rendered frame as the canvas buffer holds it. `rendered` is the viewport
 * the worker rendered it from: the buffer's own size, at the zoom times the
 * effective render scale (the render request's fields). `shift` is how far a
 * pan's blit has moved it within the buffer. `visible` is the part of it still
 * in the buffer: all of it once painted, then whatever survives each blit
 * (a pan clips one edge and fills the other with black, and a second pan
 * before a paint carries that black strip along, so the shift alone can't
 * say what's left).
 */
export interface CanvasFrame {
  readonly rendered: Viewport
  readonly shift: BufferShift
  readonly visible: FrameRegion
}

/** A frame just painted: all of it, where it was rendered. */
export function paintedFrame(rendered: Viewport): CanvasFrame {
  return {
    rendered,
    shift: NO_SHIFT,
    visible: { x0: 0, y0: 0, x1: rendered.width, y1: rendered.height },
  }
}

/**
 * `frame` blitted at a further `(dx, dy)` into a `canvas`-sized buffer: the
 * shifts add up, and only the part of its visible region that lands inside
 * the buffer survives. Rectangles intersect to a rectangle, so this composes
 * over any number of pans.
 */
export function blitFrame(
  frame: CanvasFrame,
  dx: number,
  dy: number,
  canvas: { readonly width: number; readonly height: number },
): CanvasFrame {
  const shift = { dx: frame.shift.dx + dx, dy: frame.shift.dy + dy }
  const { visible } = frame
  return {
    rendered: frame.rendered,
    shift,
    visible: {
      x0: Math.max(visible.x0, -shift.dx),
      y0: Math.max(visible.y0, -shift.dy),
      x1: Math.min(visible.x1, canvas.width - shift.dx),
      y1: Math.min(visible.y1, canvas.height - shift.dy),
    },
  }
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
