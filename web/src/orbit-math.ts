import type { BufferShift } from './input.js'
import type { BoxSize, Viewport } from './viewport.js'
import type { PreviewTransform } from './zoom-preview.js'

/**
 * Pure maths for the orbit visualizer (E1, #94): iterate a single point's
 * `z = z² + c` orbit in plain TS, and map a CSS pixel on the canvas to the
 * complex point drawn there.
 *
 * The projection is the painted frame's own: the sample of the rendered pixel
 * under the cursor (`cssToComplex`). The iteration and `BAILOUT_SQR` are a
 * deliberate mirror of the Rust source of truth (`lib.rs`'s `BAILOUT_SQR` and
 * `escape_time.rs`'s iteration): iterating one point is microseconds, so E1
 * stays entirely on the TS side with no wasm/protocol change (per the issue).
 */

/**
 * Escape threshold on `|z|²`. The renderer bails at `|z| > 256`, i.e.
 * `|z|² > 65_536`. Mirror of `BAILOUT_SQR` in `crates/fractal-core/src/lib.rs`.
 * We trace the
 * orbit against the same threshold so the polyline escapes exactly when the
 * pixel under it is coloured "outside the set".
 */
export const BAILOUT_SQR = 65_536

/**
 * The frame in the canvas buffer. `rendered` is the viewport the worker
 * rendered the painted buffer from: the buffer's own size, at the zoom times
 * the effective render scale (the render request's fields). `shift` is how far
 * a pan has since redrawn that buffer within the canvas (the drag's blit, kept
 * until the next frame paints).
 */
export interface CanvasFrame {
  readonly rendered: Viewport
  readonly shift: BufferShift
}

/**
 * The frame on screen, as the cursor sees it: the canvas frame, the
 * untransformed CSS box the canvas is stretched over (`rect`), and the zoom
 * Preview's transform on it, if one is shown.
 */
export interface ScreenFrame extends CanvasFrame {
  readonly rect: BoxSize
  readonly preview?: PreviewTransform | null
}

/**
 * Iterate `z₀ → z₁ → z₂ → …` under `z = z² + c`, returning the flat point
 * sequence `[re0, im0, re1, im1, …]` (so the caller can stride it without
 * allocating a tuple per step). Stops the first step `|z|² > bailoutSqr`
 * (escape) — keeping the escaping point so the polyline visibly crosses the
 * bailout — or after `maxIter` points for an interior orbit (which never
 * escapes and reads as a tight cluster / short cycle).
 *
 * Mandelbrot: pass `z0 = (0, 0)`, `c = clicked point`.
 * Julia:      pass `z0 = clicked point`, `c = the Julia seed`.
 */
export function traceOrbit(
  z0Re: number,
  z0Im: number,
  cRe: number,
  cIm: number,
  maxIter: number,
  bailoutSqr: number = BAILOUT_SQR,
): number[] {
  const points: number[] = []
  let re = z0Re
  let im = z0Im
  for (let i = 0; i < maxIter; i++) {
    points.push(re, im)
    if (re * re + im * im > bailoutSqr) break
    // z² + c, on number pairs: (re + im·i)² = re² − im² + 2·re·im·i
    const nextRe = re * re - im * im + cRe
    const nextIm = 2 * re * im + cIm
    re = nextRe
    im = nextIm
  }
  return points
}

/**
 * How many leading orbit points to reveal at a given moment in the looping
 * trace animation (E1). The animation walks z₀→z₁→z₂… so the dynamics are
 * visible, then holds the full path before looping.
 *
 * `elapsedMs` is time since the loop started; the cycle repeats every
 * `periodMs`. The first `sweepFraction` of each cycle reveals the path one
 * point at a time (always starting from z₀); the remainder holds the whole
 * orbit so the settled shape is readable before the next pass. Returns a count
 * in `[1, nDrawn]` (or `nDrawn` itself for the 0/1-point degenerate cases).
 */
export function revealedCount(
  elapsedMs: number,
  nDrawn: number,
  periodMs: number,
  sweepFraction: number,
): number {
  if (nDrawn <= 1) return Math.max(0, nDrawn)
  const phase = (elapsedMs % periodMs) / periodMs
  if (phase >= sweepFraction) return nDrawn
  const t = phase / sweepFraction // 0 → 1 across the sweep
  return Math.min(nDrawn, 1 + Math.floor(t * (nDrawn - 1)))
}

/**
 * Map a CSS pixel on the surface back to the complex point the pixel beneath
 * the cursor was rendered from: the sample of the containing pixel of the
 * painted buffer (`cssToPaintedPixel`'s pixel), not the cursor's exact sub-pixel
 * point. A pick, a traced orbit and the inspector's readout therefore name the
 * same sample the inspector probes, wherever in the pixel the cursor sits.
 *
 * Everything comes from the frame actually on screen, not the one last
 * requested: after a render-scale change, a resize or a permalink jump the old
 * frame stays up (CSS-stretched) until the new one paints, and the cursor is
 * over its pixels. The sample is projected through `rendered`, the viewport the
 * kernel sampled the buffer from (`pixel_to_complex` on the request), so it is
 * exact even when the buffer size was floored. Under a zoom Preview the point
 * is first carried back through the transform onto the untransformed canvas,
 * and after a pan that hasn't painted yet, back through the drag's blit onto
 * the painted buffer. A cursor beyond the painted frame's edge (a zoom-out
 * Preview, or the strip a pan exposed) clamps to the nearest edge pixel.
 *
 * The zoom anchor deliberately does not snap: it keeps the continuous
 * `cssToGrid` point so a wheel notch scales about the cursor itself.
 */
export function cssToComplex(x: number, y: number, frame: ScreenFrame): { re: number; im: number } {
  const { px, py } = cssToPaintedPixel(x, y, frame)
  return frame.rendered.pixelToComplex(px, py)
}

/**
 * The pixel of the painted buffer under CSS point `(x, y)`: the row-major
 * index the inspector probes in the worker's cached Field buffer (E2, #95), and
 * the sample `cssToComplex` names. Undoes, in turn, the Preview's CSS transform,
 * the stretch of the buffer over the box, and a pan's blit of the buffer within
 * the canvas.
 *
 * It maps against the buffer's size, *not* the viewport's logical grid: render
 * scale decouples the two (a 2× buffer is twice the logical width over the same
 * CSS box), so keying off the logical size would probe only the top-left
 * fraction at >1× and clamp along the edges at <1×. A fractional coordinate
 * stays inside its current cell, so this `floor`s to the *containing* pixel
 * rather than the nearest sample centre, then clamps into the buffer (a cursor
 * exactly on the right/bottom edge would otherwise land one past the last
 * pixel). The caller guarantees a non-degenerate box (`liveScreenFrame`, and
 * the controller for a click).
 */
export function cssToPaintedPixel(
  x: number,
  y: number,
  frame: ScreenFrame,
): { px: number; py: number } {
  const { rendered, rect, preview, shift } = frame
  const fx = preview ? (x - preview.tx) / preview.scale : x
  const fy = preview ? (y - preview.ty) / preview.scale : y
  return {
    px: clampCell(Math.floor((fx / rect.width) * rendered.width - shift.dx), rendered.width),
    py: clampCell(Math.floor((fy / rect.height) * rendered.height - shift.dy), rendered.height),
  }
}

function clampCell(cell: number, cells: number): number {
  return Math.min(Math.max(cell, 0), cells - 1)
}
