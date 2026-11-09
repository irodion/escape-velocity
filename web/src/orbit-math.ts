import type { CanvasFrame } from './canvas-content.js'
import { type BoxSize, cssToGrid, type Viewport } from './viewport.js'
import type { PreviewTransform } from './zoom-preview.js'

/**
 * Pure maths for the orbit visualizer (E1, #94): iterate a single point's
 * `z = z² + c` orbit in plain TS, and map a CSS pixel on the canvas to the
 * complex point drawn there.
 *
 * The projection is the painted frame's own: the sample of the rendered pixel
 * under the cursor (`cssToComplex`), or the exact point where nothing was
 * rendered. The iteration and `BAILOUT_SQR` are a
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
 * The frame on screen, as the cursor sees it: the frame in the canvas buffer,
 * the buffer's own size (`canvas.width`/`height`), the untransformed CSS box
 * the canvas is stretched over (`rect`), the zoom Preview's transform on it
 * (null when none is shown), and `view`, the viewport the screen depicts over
 * `rect` (the store's, or the controller's under a Preview). The buffer is the
 * frame's size except while a drag redraws an older snapshot over a frame that
 * painted mid-drag.
 */
export interface ScreenFrame extends CanvasFrame {
  readonly buffer: BoxSize
  readonly rect: BoxSize
  readonly preview: PreviewTransform | null
  readonly view: Viewport
}

/**
 * Assemble the `ScreenFrame` the cursor mappings read: the one place one is
 * built, for a hover (no Preview, the store's view) and for a click (the click
 * frame's view and Preview). Null when the canvas holds no frame yet, or for a
 * degenerate box (a `display:none` or pre-layout canvas), so callers bail
 * rather than feed NaN coordinates into `cssToComplex`.
 */
export function screenFrame(
  content: CanvasFrame | null,
  buffer: BoxSize,
  rect: BoxSize,
  view: Viewport,
  preview: PreviewTransform | null,
): ScreenFrame | null {
  if (content === null || rect.width <= 0 || rect.height <= 0) return null
  return { ...content, buffer, rect, view, preview }
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
 * the painted buffer.
 *
 * Where the cursor is beyond the painted frame (the strip a pan exposed, or
 * outside the old frame under a zoom-out Preview), nothing was rendered, so
 * there is no sample to name: the point is the exact one under the cursor in
 * `view`, the viewport the screen depicts (`cssToGrid`).
 *
 * The zoom anchor deliberately does not snap: it keeps the continuous
 * `cssToGrid` point so a wheel notch scales about the cursor itself.
 */
export function cssToComplex(x: number, y: number, frame: ScreenFrame): { re: number; im: number } {
  const pixel = cssToPaintedPixel(x, y, frame)
  if (pixel !== null) return frame.rendered.pixelToComplex(pixel.px, pixel.py)
  const grid = cssToGrid(frame.view, frame.rect, x, y)
  return frame.view.pixelToComplex(grid.x, grid.y)
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
 * rather than the nearest sample centre (a cursor exactly on the right/bottom
 * edge counts as the last pixel). Returns null when the point lies beyond the
 * painted frame, where nothing was rendered.
 */
export function cssToPaintedPixel(
  x: number,
  y: number,
  frame: ScreenFrame,
): { px: number; py: number } | null {
  const { rendered, buffer, rect, preview, shift } = frame
  const fx = preview ? (x - preview.tx) / preview.scale : x
  const fy = preview ? (y - preview.ty) / preview.scale : y
  const px = containingCell((fx / rect.width) * buffer.width - shift.dx, rendered.width)
  const py = containingCell((fy / rect.height) * buffer.height - shift.dy, rendered.height)
  return px === null || py === null ? null : { px, py }
}

// The cell of `cells` that buffer coordinate `at` falls in, or null beyond
// them. The far edge itself belongs to the last cell.
function containingCell(at: number, cells: number): number | null {
  if (!(at >= 0 && at <= cells)) return null
  return Math.min(Math.floor(at), cells - 1)
}
